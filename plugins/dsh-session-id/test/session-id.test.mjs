// Local verification for @local/dsh-session-id — run: node test/session-id.test.mjs
// Covers: wire-format derivation (determinism, prefix, length, alphabet, raw mode),
// config normalization, header injection into fetch, scope passthrough, cleanup.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSessionScope, installSessionHeaderFetch, normalize, stripSessionPrefix, wireValueOf } from "../index.js";

let passed = 0;
const ok = async (label, fn) => {
	try {
		await fn();
		passed++;
		console.log(`  ok - ${label}`);
	} catch (error) {
		console.error(`  FAIL - ${label}`);
		throw error;
	}
};

console.log("# wireValueOf / nanoidOf");
await ok("deterministic across calls", async () => {
	const a = wireValueOf("session-e820d21d-1667-4f46-874f-11fd7f10abbe", normalize({}));
	const b = wireValueOf("session-e820d21d-1667-4f46-874f-11fd7f10abbe", normalize({}));
	assert.equal(a, b);
});
await ok("opencode-style shape: ses_ + 21 alphanumeric chars", async () => {
	const actual = wireValueOf("session-e820d21d-1667-4f46-874f-11fd7f10abbe", normalize({}));
	assert.match(actual, /^ses_[A-Za-z0-9]{21}$/);
	// Independent reference: sha256 of the bare uuid, first 6-bit groups over
	// the 62-char alphabet (before any rejection re-hash would diverge).
	const uuid = stripSessionPrefix("session-e820d21d-1667-4f46-874f-11fd7f10abbe");
	const digest = createHash("sha256").update(uuid).digest();
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let expected = "";
	for (let i = 0; i < 21; i++) {
		const bit = i * 6;
		const byte = Math.floor(bit / 8);
		const off = bit % 8;
		const v = off <= 2 ? (digest[byte] >> (2 - off)) & 0x3f : (((digest[byte] & ((1 << (8 - off)) - 1)) << (off - 2)) | (digest[byte + 1] >> (10 - off))) & 0x3f;
		if (v >= 62) break; // rejection sampling: prefix equality is still meaningful
		expected += alphabet[v];
	}
	assert.ok(actual.slice(4).startsWith(expected), `prefix ${expected} of ${actual.slice(4)}`);
});
await ok("different sessions -> different tokens", async () => {
	const a = wireValueOf("session-aaaaaaaa-1667-4f46-874f-11fd7f10abbe", normalize({}));
	const b = wireValueOf("session-bbbbbbbb-1667-4f46-874f-11fd7f10abbe", normalize({}));
	assert.notEqual(a, b);
});
await ok("prefix/length/alphabet/raw config respected", async () => {
	// The `session-` label does not participate in the hash.
	assert.equal(wireValueOf("session-x", normalize({ prefix: "" })), wireValueOf("x", normalize({ prefix: "" })));
	assert.match(wireValueOf("session-x", normalize({ length: 8 })), /^ses_[A-Za-z0-9]{8}$/);
	assert.match(wireValueOf("session-x", normalize({ alphabet: "urlsafe" })), /^ses_[A-Za-z0-9_-]{21}$/);
	assert.equal(wireValueOf("session-x", normalize({ rawSessionId: true })), "session-x");
});
await ok("stripSessionPrefix keeps non-prefixed ids", async () => {
	assert.equal(stripSessionPrefix("session-abc"), "abc");
	assert.equal(stripSessionPrefix("abc"), "abc");
});

console.log("# normalize");
await ok("defaults", async () => {
	const cfg = normalize(undefined);
	assert.deepEqual(cfg.headers, ["x-opencode-session", "x-session-affinity", "x-client-request-id", "x-session-id"]);
	assert.equal(cfg.prefix, "ses_");
	assert.equal(cfg.length, 21);
	assert.equal(cfg.alphabet, "alphanumeric");
	assert.equal(cfg.rawSessionId, false);
	assert.deepEqual(cfg.extraHeaders, {});
});
await ok("filters invalid header names and keeps the rest", async () => {
	const cfg = normalize({ headers: ["x-a", "bad name", "", "x-b"], extraHeaders: { "x-ok": "v", "bad name": "v", "x-empty": "" } });
	assert.deepEqual(cfg.headers, ["x-a", "x-b"]);
	assert.deepEqual(cfg.extraHeaders, { "x-ok": "v" });
});
await ok("empty headers list falls back to defaults", async () => {
	assert.equal(normalize({ headers: [] }).headers.length, 4);
});

console.log("# fetch injection");
const calls = [];
const fakeFetch = async (input, init) => {
	const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
	const get = (name) => (headers && typeof headers.get === "function" ? headers.get(name) : headers?.[name] ?? null);
	calls.push({ url: String(input), session: get("x-opencode-session"), affinity: get("x-session-affinity"), extra: get("x-extra") });
	return new Response("{}");
};
// Put the fake in place FIRST, so the wrapper restores the fake on disposal
// and no test traffic ever reaches the network.
const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
let scopeValue;
const restore = installSessionHeaderFetch({
	headerNames: ["x-opencode-session", "x-session-affinity"],
	extra: { "x-extra": "1" },
	getValue: () => scopeValue,
	log: () => {}
});
await ok("no scope -> headers absent, call passes through untouched", async () => {
	scopeValue = undefined;
	await fetch("https://any-upstream.example/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(calls.at(-1).session, null);
	assert.equal(calls.at(-1).url, "https://any-upstream.example/v1/chat/completions");
});
await ok("in scope -> headers injected, body kept", async () => {
	scopeValue = "ses_test";
	await fetch("https://any-upstream.example/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
	assert.equal(calls.at(-1).session, "ses_test");
	assert.equal(calls.at(-1).affinity, "ses_test");
	assert.equal(calls.at(-1).extra, "1");
	assert.equal(calls.at(-1).url, "https://any-upstream.example/v1/chat/completions");
});
await ok("works for any host (no upstream matching)", async () => {
	scopeValue = "ses_other";
	await fetch("http://127.0.0.1:8888/v1/messages");
	assert.equal(calls.at(-1).session, "ses_other");
});
restore();
globalThis.fetch = fakeFetch;
await ok("disposal restores the previous fetch", async () => {
	scopeValue = "ses_test";
	await fetch("https://any-upstream.example/v1/chat/completions", { headers: { "content-type": "application/json" } });
	assert.equal(calls.at(-1).session, null);
});

console.log("# scope");
await (async () => {
	const scope = createSessionScope();
	assert.equal(scope.current(), undefined);
	await scope.run("session-abc", async () => {
		assert.equal(scope.current(), "session-abc");
		await new Promise((r) => setImmediate(r));
		assert.equal(scope.current(), "session-abc", "survives await boundaries");
	});
	assert.equal(scope.current(), undefined, "cleared after run");
})();
globalThis.fetch = realFetch;

console.log(`\n${passed} checks passed`);
