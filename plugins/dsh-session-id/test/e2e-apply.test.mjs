// End-to-end simulation: apply() + llm/stream waterfall + concurrent sessions.
// Verifies each conversation's stream carries its own session header and that
// non-session traffic stays clean. Run: node test/e2e-apply.test.mjs
import assert from "node:assert/strict";
import { apply } from "../index.js";

const seen = [];
const realFetch = globalThis.fetch;
const getHeader = (headers, name) => {
	if (!headers) return null;
	if (typeof headers.get === "function") return headers.get(name);
	return headers[name] ?? null;
};
globalThis.fetch = async (input, init) => {
	seen.push({ url: String(input), session: getHeader(init?.headers, "x-opencode-session") });
	return new Response("{}");
};

const effects = [];
const listeners = {};
const ctx = {
	logger: { info: () => {}, debug: () => {} },
	on(event, fn) {
		listeners[event] = fn;
	},
	effect(fn) {
		effects.push(fn);
	}
};

apply(ctx, {});

assert.equal(typeof listeners["llm/stream"], "function", "llm/stream listener registered");
assert.equal(effects.length, 1, "fetch restore effect registered");

// Minimal async-iterable chunk stream; the adapter's fetch fires on first pull.
function fakeDownstream(url) {
	return {
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				next: async () => {
					if (i++ === 0) {
						await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
						return { done: false, value: { type: "text", text: "x" } };
					}
					return { done: true, value: undefined };
				}
			};
		}
	};
}

const SESSION_A = "session-aaaaaaaa-1667-4f46-874f-11fd7f10abbe";
const SESSION_B = "session-bbbbbbbb-1667-4f46-874f-11fd7f10abbe";

// Two concurrent session-scoped calls interleaved with one out-of-scope call.
const nextA = () => fakeDownstream("https://up-a.example/v1/chat/completions");
const nextB = () => fakeDownstream("https://up-b.example/v1/messages");
const outOfScope = listeners["llm/stream"]({ provider: "x", model: "m" }, () => fakeDownstream("https://no-session.example/v1"));
const streamA = listeners["llm/stream"]({ provider: "p", model: "m", sessionId: SESSION_A }, nextA);
const streamB = listeners["llm/stream"]({ provider: "p", model: "m", sessionId: SESSION_B }, nextB);

const pullAll = async (stream) => {
	for await (const chunk of stream) if (chunk?.done) break;
};
await Promise.all([pullAll(outOfScope), pullAll(streamA), pullAll(streamB)]);

const byUrl = Object.fromEntries(seen.map((c) => [new URL(c.url).host, c.session]));
assert.notEqual(byUrl["up-a.example"], byUrl["up-b.example"], "concurrent sessions must not cross-contaminate");
assert.match(byUrl["up-a.example"], /^ses_[A-Za-z0-9]{21}$/);
assert.equal(byUrl["no-session.example"], null, "no sessionId -> no headers, no guessing");
assert.ok(effects.length === 1);
console.log("seen:", seen.map((c) => `${new URL(c.url).host} ← ${c.session ?? "(none)"}`).join(" | "));

effects[0]();
globalThis.fetch = realFetch;
console.log("e2e OK");
