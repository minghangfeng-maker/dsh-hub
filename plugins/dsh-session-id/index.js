import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/**
 * dsh-session-id — give every DSH conversation one stable, opencode-style
 * session id and send it as request headers on every model request.
 *
 * Where the id comes from: `dsh-agent-loop` stamps `options.sessionId` on
 * every request it builds (conversation steps, steering, compaction, session
 * titles — verified in the installed harness), and it is minted once per
 * conversation, stable across turns, resume, forks and retries. A request
 * without a session id (a hand-built one-shot) is out of scope for this
 * plugin: it is passed through untouched, with no model/upstream guessing.
 *
 * How the value reaches the wire: the pi-ai adapter does not forward
 * per-request headers, so injection happens on the actual HTTP request. The
 * `llm/stream` waterfall listener scopes each streamed call to its session id
 * via AsyncLocalStorage, and a `globalThis.fetch` wrapper adds the headers to
 * requests issued inside that scope. No URL/provider matching: every fetch
 * fired while a session-scoped model call is in flight gets the headers.
 * The wrapper never reads or rewrites bodies, URLs, methods or signals, and
 * restores the previous fetch on disposal unless another wrapper took over.
 *
 * Wire value format (opencode-style, from `packages/opencode/src/id/id.ts`):
 * opencode session ids are a fixed `ses_` label plus a nanoid-style random
 * token. DSH already guarantees the uniqueness half; this plugin derives the
 * token half deterministically — SHA-256 of the conversation uuid, encoded
 * over a 62-char alphanumeric alphabet (default 21 chars, nanoid's length).
 * Deterministic means the same conversation carries the same token across
 * requests, process restarts and compaction, which is what upstream session
 * affinity needs. `rawSessionId: true` sends the raw dsh session id instead.
 *
 * @module @xdedmi/dsh-session-id
 */

const name = "dsh-session-id";

/** nanoid-style alphabet, symbol-free: 62 chars, uniform via rejection sampling. */
const NANOID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** opencode's classic URL-safe nanoid alphabet (64 chars, includes `-` and `_`). */
const NANOID_ALPHABET_URLSAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const NANOID_ALPHABETS = { alphanumeric: NANOID_ALPHABET, urlsafe: NANOID_ALPHABET_URLSAFE };

/** HTTP header-name grammar (RFC 9110 token). */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Default wire headers, mirroring opencode's own emission family. */
const DEFAULT_HEADERS = ["x-opencode-session", "x-session-affinity", "x-client-request-id", "x-session-id"];

/**
 * Deterministic nanoid-style token from a string: SHA-256, walked 6 bits at a
 * time over the alphabet, rejection sampling keeps the distribution uniform.
 * Same input always yields the same token, across requests and restarts.
 */
function nanoidOf(input, length, alphabet) {
	const digest = createHash("sha256").update(String(input)).digest();
	const size = alphabet.length;
	let out = "";
	let bit = 0;
	while (out.length < length) {
		if (bit + 6 > digest.length * 8) {
			digest = createHash("sha256").update(String(input)).update(`#${out.length}`).digest();
			bit = 0;
		}
		const byteIndex = bit >> 3;
		const bitOffset = bit & 7;
		let value;
		if (bitOffset <= 2) {
			value = (digest[byteIndex] >> (2 - bitOffset)) & 0x3f;
		} else {
			value = ((digest[byteIndex] & ((1 << (8 - bitOffset)) - 1)) << (bitOffset - 2)) | (digest[byteIndex + 1] >> (10 - bitOffset));
		}
		value &= 0x3f;
		bit += 6;
		if (value >= size) continue;
		out += alphabet[value];
	}
	return out;
}

/**
 * Strip the dsh `session-` label so the wire token hashes only the uuid part,
 * independent of the naming convention of the harness version. Ids without
 * the prefix pass through unchanged.
 */
function stripSessionPrefix(id) {
	return String(id).replace(/^session-/, "");
}

/** Tolerate every shape a patch layer may deliver; defaults apply per key. */
function normalize(config) {
	const c = config ?? {};
	const stringList = (value, fallback) =>
		Array.isArray(value) && value.length > 0
			? value.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
			: fallback;
	let headers = stringList(c.headers, DEFAULT_HEADERS);
	if (headers.length === 0) headers = DEFAULT_HEADERS;
	const prefix = typeof c.prefix === "string" ? c.prefix : "ses_";
	return {
		headers: [...new Set(headers)].filter((h) => HEADER_NAME_TOKEN.test(h)),
		/** Fixed id label kept on the wire, like opencode's `ses_`. Set "" to drop it. */
		prefix,
		/** nanoid-style token length; opencode uses 21 random chars after `ses_`. */
		length: Number.isInteger(c.length) && c.length >= 4 && c.length <= 64 ? c.length : 21,
		/** Token alphabet: `alphanumeric` (default) or `urlsafe` (nanoid's 64 chars). */
		alphabet: NANOID_ALPHABETS[c.alphabet] ? c.alphabet : "alphanumeric",
		/** Send the raw dsh session id instead of the derived opencode-style token. */
		rawSessionId: c.rawSessionId === true,
		/** Extra static request headers injected alongside the session id. */
		extraHeaders: pairsOf(c.extraHeaders),
		/** Debug-log each scope and each injected request to the plugin logger. */
		verbose: c.verbose === true
	};
}

/** Pair validation for `extraHeaders`. */
function pairsOf(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const out = {};
	for (const [h, v] of Object.entries(value)) {
		if (typeof v !== "string" || v.length === 0) continue;
		const key = h.trim();
		if (!HEADER_NAME_TOKEN.test(key)) continue;
		out[key] = v;
	}
	return out;
}

/** AsyncLocalStorage scope binding one streamed LLM call to its session id. */
function createSessionScope() {
	const store = new AsyncLocalStorage();
	return {
		current() {
			return store.getStore();
		},
		run(sessionId, fn) {
			return store.run(String(sessionId), fn);
		}
	};
}

/**
 * Wrap a downstream LLM chunk stream so every pull runs inside the scope,
 * keeping the session id visible to everything the adapter does on that pull
 * (pi-ai fires its HTTP request synchronously from the stream's first pull).
 */
function scopedIterable(scope, sessionId, iterable) {
	const iterator = iterable[Symbol.asyncIterator]();
	const inside = (method, args) =>
		scope.run(sessionId, () => {
			const fn = iterator[method];
			return typeof fn === "function" ? fn.apply(iterator, args) : undefined;
		});
	const fallbackDone = Promise.resolve({ done: true, value: undefined });
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		next() {
			return inside("next", []) ?? fallbackDone;
		},
		return(...args) {
			return inside("return", args) ?? fallbackDone;
		},
		throw(...args) {
			return inside("throw", args) ?? fallbackDone;
		}
	};
}

/** The wire value for a session id: `ses_` + deterministic nanoid-style token. */
function wireValueOf(raw, cfg) {
	if (cfg.rawSessionId) return String(raw);
	return `${cfg.prefix}${nanoidOf(stripSessionPrefix(raw), cfg.length, NANOID_ALPHABETS[cfg.alphabet])}`;
}

/**
 * Rebuild a fetch call with the session headers added, preserving everything
 * else (method, body, signal, duplex, credentials). Returns `null` when the
 * call cannot be rebuilt (e.g. a body-already-used Request); the caller then
 * passes the original call through untouched.
 */
function withSessionHeaders(input, init, headerNames, value, extra) {
	const source = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
	const headers = new Headers(source ?? undefined);
	for (const headerName of headerNames) headers.set(headerName, value);
	for (const [headerName, v] of Object.entries(extra)) headers.set(headerName, v);
	if (typeof init === "object" && init !== null) return { input, init: { ...init, headers } };
	if (typeof Request !== "undefined" && input instanceof Request) {
		try {
			return { input: new Request(input, { headers }), init: undefined };
		} catch {
			return null;
		}
	}
	return { input, init: { headers } };
}

/**
 * Wrap `globalThis.fetch` so requests issued inside a session scope carry the
 * session headers — with no URL, host or provider matching. One wrapper per
 * mount; disposal restores the previous fetch unless another wrapper already
 * took its place.
 */
function installSessionHeaderFetch({ headerNames, extra, getValue, log }) {
	const original = globalThis.fetch;
	if (typeof original !== "function") return () => {};
	const wrapped = (input, init) => {
		let nextInput = input;
		let nextInit = init;
		try {
			const value = getValue();
			if (value !== undefined && headerNames.length > 0) {
				const merged = withSessionHeaders(input, init, headerNames, value, extra);
				if (merged !== null) {
					nextInput = merged.input;
					nextInit = merged.init;
					log(`injected ${headerNames.join(", ")}: ${value}${Object.keys(extra).length > 0 ? ` + ${Object.entries(extra).map(([h, v]) => `${h}: ${v}`).join(", ")}` : ""}`);
				}
			}
		} catch (error) {
			log(`skipped header injection: ${error?.message ?? error}`);
		}
		return original.call(globalThis, nextInput, nextInit);
	};
	globalThis.fetch = wrapped;
	return () => {
		if (globalThis.fetch === wrapped) globalThis.fetch = original;
	};
}

/** Install the plugin on a cordis context. */
function apply(ctx, config = {}) {
	const cfg = normalize(config);
	const scope = createSessionScope();
	const log = (message) => {
		if (!cfg.verbose) return;
		ctx.logger.debug(`dsh-session-id: ${message}`);
	};
	ctx.logger.info(
		`dsh-session-id: injecting [${cfg.headers.join(", ")}] on every session-scoped model request (format: ${cfg.rawSessionId ? "raw session id" : `${cfg.prefix}+nanoid${cfg.length}(${cfg.alphabet})`}${Object.keys(cfg.extraHeaders).length > 0 ? `, extra: ${Object.entries(cfg.extraHeaders).map(([h, v]) => `${h}: ${v}`).join(", ")}` : ""})`
	);
	// 1. Scope every streamed LLM call to its conversation session id. Chunks
	//    and call options pass through untouched; requests without a session
	//    id (hand-built one-shots) fall through with no model/upstream check.
	ctx.on("llm/stream", (options, next) => {
		const sessionId = options.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) return next();
		log(`scoping ${options.provider}/${options.model} to session ${sessionId} → wire ${wireValueOf(sessionId, cfg)}`);
		return scopedIterable(scope, sessionId, next());
	});
	// 2. Wire-level injection: while a session-scoped call is in flight, every
	//    fetch it issues (adapter HTTP request, redirect follow, retry) sees
	//    the headers. Requests outside any session scope pass through clean.
	const restoreFetch = installSessionHeaderFetch({
		headerNames: cfg.headers,
		extra: cfg.extraHeaders,
		getValue: () => {
			const sessionId = scope.current();
			return sessionId === undefined ? undefined : wireValueOf(sessionId, cfg);
		},
		log
	});
	ctx.effect(() => restoreFetch, "dsh-session-id: restore global fetch");
}

export {
	DEFAULT_HEADERS,
	NANOID_ALPHABET,
	NANOID_ALPHABET_URLSAFE,
	apply,
	createSessionScope,
	installSessionHeaderFetch,
	name,
	nanoidOf,
	normalize,
	scopedIterable,
	stripSessionPrefix,
	withSessionHeaders,
	wireValueOf
};
export default { name, apply };
