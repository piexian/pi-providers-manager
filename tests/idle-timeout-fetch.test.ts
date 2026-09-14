import assert from "node:assert/strict";
import { test } from "node:test";
import { withIdleTimeout } from "../src/idle-timeout-fetch.ts";

test("disabled idle timeout preserves the original fetch function", () => {
	const original: typeof fetch = async () => new Response("ok");
	assert.equal(withIdleTimeout(original, 0), original);
});

test("HTTP status, headers, body, request headers and body are preserved", async () => {
	const original: typeof fetch = async (_input, init) => {
		assert.equal(init?.body, "payload");
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer dummy");
		return new Response("response", { status: 201, headers: { "x-test": "keep" } });
	};
	const response = await withIdleTimeout(original, 200)("https://offline.invalid/v1/responses", { method: "POST", body: "payload", headers: { authorization: "Bearer dummy" } });
	assert.equal(response.status, 201);
	assert.equal(response.headers.get("x-test"), "keep");
	assert.equal(await response.text(), "response");
});

test("a hung HTTP handshake has a bounded timeout even if fetch ignores abort", async () => {
	let signal: AbortSignal | undefined;
	const original: typeof fetch = async (_input, init) => {
		signal = init?.signal ?? undefined;
		return new Promise(() => {});
	};
	await assert.rejects(withIdleTimeout(original, 10)("https://offline.invalid"), /idle timeout/);
	assert.equal(signal?.aborted, true);
});

test("a hung response body fails and cancels the underlying stream", async () => {
	let cancelled = false;
	const original: typeof fetch = async () => new Response(new ReadableStream({
		pull: () => new Promise(() => {}),
		cancel: () => { cancelled = true; },
	}));
	const response = await withIdleTimeout(original, 10)("https://offline.invalid");
	await assert.rejects(response.text(), /idle timeout/);
	assert.equal(cancelled, true);
});

test("pre-aborted requests never call fetch", async () => {
	let calls = 0;
	const original: typeof fetch = async () => { calls++; return new Response("ok"); };
	await assert.rejects(withIdleTimeout(original, 50)("https://offline.invalid", { signal: AbortSignal.abort() }), { name: "AbortError" });
	assert.equal(calls, 0);
});

test("consumer cancellation aborts the request and releases the body", async () => {
	let cancelled = false;
	let signal: AbortSignal | undefined;
	const original: typeof fetch = async (_input, init) => {
		signal = init?.signal ?? undefined;
		return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }));
	};
	const response = await withIdleTimeout(original, 500)("https://offline.invalid");
	await response.body!.cancel();
	assert.equal(cancelled, true);
	assert.equal(signal?.aborted, true);
});
