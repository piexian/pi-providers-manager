import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { ResponsesWebSocketTransport } from "../src/responses-websocket.ts";
import type { ResponsesWebSocketOptions, ResponsesWebSocketFactory } from "../src/responses-websocket.ts";

const endpoint = "https://provider.invalid/proxy/v1/responses?route=test";
const dummyHeaders = { authorization: "Bearer dummy-test-key", "content-type": "application/json" };
const input = [{ role: "user", content: "hello" }];
const output = [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }] }];

class FakeSocket extends EventTarget {
	readyState = 0;
	binaryType = "blob";
	sent: Record<string, unknown>[] = [];
	closed = 0;
	onSend?: (body: Record<string, unknown>) => void;
	listeners = new Map<string, Set<EventListener>>();
	addEventListener(type: string, listener: EventListener): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
		super.addEventListener(type, listener);
	}
	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener);
		super.removeEventListener(type, listener);
	}
	get listenerCount(): number { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
	open(): void { this.readyState = 1; this.dispatchEvent(new Event("open")); }
	message(value: unknown): void { this.raw(JSON.stringify(value)); }
	raw(data: unknown): void { this.dispatchEvent(new MessageEvent("message", { data })); }
	error(): void { this.dispatchEvent(new Event("error")); }
	remoteClose(): void { this.readyState = 3; this.dispatchEvent(new Event("close")); }
	send(data: string): void {
		assert.equal(this.readyState, 1);
		const body = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(body);
		this.onSend?.(body);
	}
	close(): void { this.closed++; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

function harness(t: TestContext, settings: { autoOpen?: boolean; transport?: ResponsesWebSocketOptions["transport"]; sessionId?: string; connectTimeoutMs?: number; idleTimeoutMs?: number; onSend?: FakeSocket["onSend"] } = {}) {
	const sockets: FakeSocket[] = [];
	const handshakes: { url: string; headers: Record<string, string> }[] = [];
	const fallbacks: Request[] = [];
	const notices: string[] = [];
	const factory: ResponsesWebSocketFactory = (url, options) => {
		const socket = new FakeSocket();
		socket.onSend = settings.onSend;
		sockets.push(socket);
		handshakes.push({ url, headers: options.headers });
		if (settings.autoOpen !== false) queueMicrotask(() => socket.open());
		return socket;
	};
	const transport = new ResponsesWebSocketTransport(factory);
	t.after(() => {
		transport.close();
		for (const socket of sockets) assert.equal(socket.listenerCount, 0, "no socket listeners remain after shutdown");
	});
	const fallbackFetch: typeof fetch = async (request, init) => {
		fallbacks.push(new Request(request, init));
		return new Response("HTTP fallback", { headers: { "content-type": "text/event-stream" } });
	};
	const options: ResponsesWebSocketOptions = {
		transport: settings.transport ?? "websocket", sessionId: settings.sessionId,
		connectTimeoutMs: settings.connectTimeoutMs ?? 1000, idleTimeoutMs: settings.idleTimeoutMs ?? 1000,
		fallbackFetch, onFallback: (reason) => notices.push(reason),
	};
	const fetch = transport.createFetch(options);
	const request = (body: Record<string, unknown> = { model: "dummy", input, stream: true }, init: RequestInit = {}) =>
		fetch(endpoint, { method: "POST", headers: dummyHeaders, body: JSON.stringify(body), ...init });
	return { transport, sockets, handshakes, fallbacks, notices, options, fetch, request };
}

async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (check()) return;
		await delay(1);
	}
	assert.fail("condition did not become true");
}

function complete(socket: FakeSocket, id = "resp_1", items: unknown[] = output): void {
	socket.message({ type: "response.completed", response: { id, status: "completed", output: items } });
}
function parseSse(text: string): unknown[] {
	return text.split("\n\n").filter(Boolean).map((frame) => {
		assert.ok(frame.startsWith("data: "));
		return JSON.parse(frame.slice(6));
	});
}

for (const mode of ["auto", "websocket", "websocket-cached"] as const) {
	test(`${mode} ignores CPA metadata before output and while idle, then reuses context connection`, async (t) => {
		const h = harness(t, { sessionId: "quota-session", transport: mode });
		const first = await h.request();
		h.sockets[0].message({ type: "codex.rate_limits", plan_type: "dummy", rate_limits: {} });
		h.sockets[0].message({ type: "codex.response.metadata", metadata: {} });
		h.sockets[0].message({ type: "future.metadata", data: {} });
		h.sockets[0].message({ type: "responsesapi.websocket_timing", duration_ms: 1 });
		complete(h.sockets[0]);
		assert.doesNotMatch(await first.text(), /codex\.|responsesapi\.|future\.metadata|plan_type/);
		h.sockets[0].message({ type: "codex.rate_limits", rate_limits: {} });
		h.sockets[0].message({ type: "codex.response.metadata", metadata: {} });
		assert.equal(h.sockets[0].readyState, 1);
		const next = await h.request({ model: "dummy", input: [...input, ...output, { role: "user", content: "next turn" }] });
		assert.equal(h.sockets.length, 1);
		h.sockets[0].message({ type: "codex.rate_limits", rate_limits: {} });
		complete(h.sockets[0], "resp_2");
		assert.match(await next.text(), /response.completed/);
		assert.equal(h.fallbacks.length, 0);
	});
}

test("quota notifications are not a successful response or a reason to replay over HTTP", async (t) => {
	const h = harness(t, { transport: "auto", idleTimeoutMs: 10 });
	const response = await h.request();
	h.sockets[0].message({ type: "codex.rate_limits", rate_limits: {} });
	await assert.rejects(response.text(), /idle timeout/);
	assert.equal(h.fallbacks.length, 0);
});

test("rotating tracing headers reuse WS and cached context without retaining idle duplicates", async (t) => {
	const h = harness(t, { sessionId: "trace-session", transport: "websocket-cached", idleTimeoutMs: 0 });
	const first = await h.request({ model: "dummy", input }, { headers: { ...dummyHeaders, "x-client-request-id": "request-1", traceparent: "trace-1" } });
	complete(h.sockets[0]); await first.text();
	const second = await h.request({ model: "dummy", input: [...input, ...output, { role: "user", content: "next" }] }, { headers: { ...dummyHeaders, "x-client-request-id": "request-2", traceparent: "trace-2" } });
	assert.equal(h.sockets.length, 1);
	assert.equal(h.sockets[0].sent[1].previous_response_id, "resp_1");
	complete(h.sockets[0]); await second.text();
});

test("credential and routing changes cannot accumulate idle sockets when expiry is disabled", async (t) => {
	const h = harness(t, { sessionId: "rotate-session", idleTimeoutMs: 0 });
	for (let i = 0; i < 3; i++) {
		const response = await h.request(undefined, { headers: { ...dummyHeaders, authorization: `Bearer dummy-${i}`, "x-route": `route-${i}` } });
		complete(h.sockets[i]); await response.text();
	}
	assert.equal(h.sockets.length, 3);
	assert.equal(h.sockets.filter((socket) => socket.readyState === 1).length, 1);
});

test("known provider error categories survive redaction but arbitrary messages do not", async (t) => {
	const h = harness(t);
	for (const [code, expected] of [["context_length_exceeded", /context_length_exceeded/], ["rate_limit_exceeded", /rate limit/], ["insufficient_quota", /insufficient_quota/], ["server_error", /503/]] as const) {
		const response = await h.request();
		h.sockets.at(-1)!.message({ type: "error", error: { code, message: "dummy-secret-server-message" } });
		await assert.rejects(response.text(), (error: Error) => expected.test(error.message) && !error.message.includes("dummy-secret-server-message"));
	}
});

// All fake credentials are explicitly nonfunctional; .invalid is never contacted.
test("construction and createFetch are lazy; validates finite timeout bounds", (t) => {
	const h = harness(t);
	assert.equal(h.sockets.length, 0);
	for (const value of [-1, NaN, Infinity, 2_147_483_648]) {
		assert.throws(() => h.transport.createFetch({ ...h.options, connectTimeoutMs: value }), /timeout/);
		assert.throws(() => h.transport.createFetch({ ...h.options, idleTimeoutMs: value }), /timeout/);
	}
	assert.doesNotThrow(() => h.transport.createFetch({ ...h.options, connectTimeoutMs: 0, idleTimeoutMs: 0 }));
});

test("normal text and tool events are preserved as SSE frames; terminal closes non-session socket", async (t) => {
	const h = harness(t);
	const response = await h.request({ model: "dummy", input, stream: true, background: false, type: "untrusted" });
	assert.equal(response.headers.get("content-type"), "text/event-stream");
	const socket = h.sockets[0];
	assert.deepEqual(socket.sent[0], { model: "dummy", input, type: "response.create" });
	const events = [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		{ type: "response.output_text.delta", delta: "hello\nworld", output_index: 0, content_index: 0 },
		{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" } },
		{ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"q":' },
		{ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"q":"test"}' },
		{ type: "response.completed", response: { id: "resp_1", status: "completed", output } },
	];
	for (const event of events) socket.message(event);
	assert.deepEqual(parseSse(await response.text()), events);
	assert.equal(socket.closed, 1);
	assert.equal(socket.listenerCount, 0);
	assert.equal(h.fallbacks.length, 0);
});

test("derives ws URL preserving path/query and filters framing headers, not custom/auth headers", async (t) => {
	const h = harness(t);
	const response = await h.request(undefined, { headers: {
		...dummyHeaders, accept: "text/event-stream", "accept-encoding": "gzip", "content-length": "10",
		connection: "upgrade, x-hop", upgrade: "websocket", "x-hop": "remove", host: "wrong.invalid",
		"sec-websocket-key": "replace", "x-custom": "dummy-custom", "openai-organization": "dummy-org",
	} });
	assert.deepEqual(h.handshakes[0], { url: "wss://provider.invalid/proxy/v1/responses?route=test", headers: {
		authorization: "Bearer dummy-test-key", "openai-organization": "dummy-org", "x-custom": "dummy-custom",
	} });
	complete(h.sockets[0]);
	await response.text();
});

test("refuses unrelated methods, paths, credentials, fragments and invalid JSON without fallback", async (t) => {
	const h = harness(t, { transport: "auto" });
	for (const url of ["https://provider.invalid/v1/chat/completions", "https://user:dummy@provider.invalid/v1/responses", "https://provider.invalid/v1/responses#fragment", "ftp://provider.invalid/v1/responses"]) {
		await assert.rejects(h.fetch(url, { method: "POST", body: "{}" }));
	}
	await assert.rejects(h.fetch(endpoint, { method: "GET" }));
	for (const body of ["not-json", "null", "[]", '"str"']) await assert.rejects(h.fetch(endpoint, { method: "POST", body }), /JSON object/);
	assert.equal(h.sockets.length, 0);
	assert.equal(h.fallbacks.length, 0);
});

for (const mode of ["websocket", "websocket-cached"] as const) {
	test(`${mode} handshake failure never falls back`, async (t) => {
		const h = harness(t, { transport: mode, autoOpen: false });
		const pending = h.request();
		await until(() => h.sockets.length === 1);
		h.sockets[0].error();
		await assert.rejects(pending, /handshake failed/);
		assert.equal(h.fallbacks.length, 0);
		assert.equal(h.notices.length, 0);
		assert.equal(h.sockets[0].listenerCount, 0);
	});
}

test("auto handshake failure uses original HTTP Request body and emits a sanitized notice", async (t) => {
	const h = harness(t, { transport: "auto", autoOpen: false });
	const body = { model: "dummy", input, stream: true, background: false };
	const original = new Request(endpoint, { method: "POST", headers: dummyHeaders, body: JSON.stringify(body) });
	const pending = h.fetch(original);
	await until(() => h.sockets.length === 1);
	h.sockets[0].error();
	assert.equal(await (await pending).text(), "HTTP fallback");
	assert.equal(h.fallbacks.length, 1);
	assert.deepEqual(await h.fallbacks[0].json(), body);
	assert.equal(h.fallbacks[0].headers.get("authorization"), dummyHeaders.authorization);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0], /before request send/);
	assert.doesNotMatch(h.notices[0], /dummy-test-key|provider.invalid/);
});

test("auto constructor failure can fall back, without exposing constructor error payload", async () => {
	let calls = 0;
	const notices: string[] = [];
	const transport = new ResponsesWebSocketTransport(() => { throw new Error("dummy-sensitive-url"); });
	const fetch = transport.createFetch({ transport: "auto", fallbackFetch: async () => { calls++; return new Response("fallback"); }, onFallback: (reason) => notices.push(reason) });
	assert.equal(await (await fetch(endpoint, { method: "POST", body: "{}" })).text(), "fallback");
	assert.equal(calls, 1);
	assert.doesNotMatch(notices.join(), /dummy-sensitive-url/);
	transport.close();
});

test("auto never falls back after send, including synchronous send failure", async (t) => {
	const h = harness(t, { transport: "auto", onSend: () => { throw new Error("send failed"); } });
	const response = await h.request();
	await assert.rejects(response.text(), /send failed/);
	assert.equal(h.sockets[0].sent.length, 1);
	assert.equal(h.fallbacks.length, 0);
});

test("successful handshake followed by closure before send is not an auto fallback opportunity", async (t) => {
	const h = harness(t, { transport: "auto", autoOpen: false });
	const pending = h.request();
	await until(() => h.sockets.length === 1);
	h.sockets[0].open();
	h.sockets[0].remoteClose();
	await assert.rejects((await pending).text(), /closed before request send/);
	assert.equal(h.sockets[0].sent.length, 0);
	assert.equal(h.fallbacks.length, 0);
});

test("already-aborted and opening cancellation never fall back", async (t) => {
	const h = harness(t, { transport: "auto", autoOpen: false });
	const first = new AbortController();
	first.abort();
	await assert.rejects(h.request(undefined, { signal: first.signal }), { name: "AbortError" });
	assert.equal(h.sockets.length, 0);
	const abort = new AbortController();
	const pending = h.request(undefined, { signal: abort.signal });
	await until(() => h.sockets.length === 1);
	abort.abort();
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(h.sockets[0].closed, 1);
	assert.equal(h.sockets[0].listenerCount, 0);
	assert.equal(h.fallbacks.length, 0);
});

test("streaming abort closes and evicts the socket rather than releasing it for reuse", async (t) => {
	const h = harness(t, { transport: "auto", sessionId: "session" });
	const abort = new AbortController();
	const response = await h.request(undefined, { signal: abort.signal });
	const reader = response.body!.getReader();
	h.sockets[0].message({ type: "response.output_text.delta", delta: "first" });
	assert.equal((await reader.read()).done, false);
	abort.abort();
	await assert.rejects(reader.read(), { name: "AbortError" });
	assert.equal(h.sockets[0].listenerCount, 0);
	const next = await h.request();
	assert.equal(h.sockets.length, 2);
	complete(h.sockets[1]);
	await next.text();
	assert.equal(h.fallbacks.length, 0);
});

test("consumer cancel closes an active session socket and never permits stale response reuse", async (t) => {
	const h = harness(t, { sessionId: "session" });
	const first = await h.request();
	await first.body!.cancel();
	assert.equal(h.sockets[0].closed, 1);
	assert.equal(h.sockets[0].listenerCount, 0);
	const second = await h.request();
	assert.equal(h.sockets.length, 2);
	h.sockets[0].message({ type: "response.output_text.delta", delta: "stale" });
	complete(h.sockets[1]);
	assert.doesNotMatch(await second.text(), /stale/);
});

test("connect timeout permits auto fallback only before send; strict mode rejects", async (t) => {
	const auto = harness(t, { transport: "auto", autoOpen: false, connectTimeoutMs: 10 });
	assert.equal(await (await auto.request()).text(), "HTTP fallback");
	assert.match(auto.notices[0], /WebSocket connect timeout \(10 ms\)/);
	assert.equal(auto.sockets[0].sent.length, 0);
	assert.equal(auto.sockets[0].listenerCount, 0);
	const strict = harness(t, { autoOpen: false, connectTimeoutMs: 10 });
	await assert.rejects(strict.request(), /connect timeout/);
	assert.equal(strict.fallbacks.length, 0);
});

test("idle timeout after send errors the stream without HTTP replay", async (t) => {
	const h = harness(t, { transport: "auto", idleTimeoutMs: 10 });
	const response = await h.request();
	await assert.rejects(response.text(), /idle timeout/);
	assert.equal(h.fallbacks.length, 0);
	assert.equal(h.sockets[0].listenerCount, 0);
});

test("zero timeouts are disabled for opening and streaming", async (t) => {
	const h = harness(t, { autoOpen: false, connectTimeoutMs: 0, idleTimeoutMs: 0 });
	const pending = h.request();
	await until(() => h.sockets.length === 1);
	await delay(15);
	assert.equal(h.sockets[0].closed, 0);
	h.sockets[0].open();
	const response = await pending;
	await delay(15);
	assert.equal(h.sockets[0].closed, 0);
	complete(h.sockets[0]);
	await response.text();
});

for (const [label, event, expected] of [
	["malformed JSON", "{", /Invalid WebSocket JSON/],
	["JSON primitive", "null", /Invalid WebSocket response event/],
	["missing type", "{}", /Invalid WebSocket response event/],
	["blank event type", JSON.stringify({ type: "" }), /Invalid WebSocket response event/],
	["top-level server error", JSON.stringify({ type: "error", error: { code: "server_error", message: "dummy-private-payload" } }), /503 upstream server error/],
	["failed response", JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "server_error" } } }), /503 upstream server error/],
	["invalid terminal", JSON.stringify({ type: "response.completed" }), /Invalid WebSocket terminal response/],
	["failed status in completion", JSON.stringify({ type: "response.completed", response: { status: "failed", output: [] } }), /Invalid WebSocket terminal response/],
] as const) {
	test(`${label} errors the stream and evicts socket, never HTTP-falls back`, async (t) => {
		const h = harness(t, { transport: "auto", sessionId: "session" });
		const response = await h.request();
		h.sockets[0].raw(event);
		await assert.rejects(response.text(), expected);
		assert.equal(h.sockets[0].closed, 1);
		assert.equal(h.sockets[0].listenerCount, 0);
		assert.equal(h.fallbacks.length, 0);
	});
}

for (const action of ["error", "remoteClose"] as const) {
	test(`${action} after send cannot look like successful empty output`, async (t) => {
		const h = harness(t, { transport: "auto" });
		const response = await h.request();
		h.sockets[0][action]();
		await assert.rejects(response.text(), /WebSocket/);
		assert.equal(h.fallbacks.length, 0);
	});
}

test("binary JSON frames decode and incomplete terminal is preserved", async (t) => {
	const h = harness(t);
	const response = await h.request();
	const event = { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } } };
	h.sockets[0].raw(new TextEncoder().encode(JSON.stringify(event)).buffer);
	assert.deepEqual(parseSse(await response.text()), [event]);
	assert.equal(h.sockets[0].closed, 1);
});

test("session reuses only terminally completed connections; full-body mode always sends full context", async (t) => {
	const h = harness(t, { sessionId: "session" });
	const first = await h.request();
	complete(h.sockets[0]);
	// Reuse is safe on wire completion even when the first consumer has not drained its own buffer.
	const body = { model: "dummy", input: [...input, ...output, { role: "user", content: "next" }], stream: true };
	const second = await h.request(body);
	assert.equal(h.sockets.length, 1);
	assert.deepEqual(h.sockets[0].sent[1], { model: body.model, input: body.input, type: "response.create" });
	complete(h.sockets[0], "resp_2");
	await first.text();
	await second.text();
	assert.equal(h.sockets[0].closed, 0);
});

test("cancelling an old terminal response body cannot close a subsequently reused active socket", async (t) => {
	const h = harness(t, { sessionId: "session" });
	const first = await h.request();
	complete(h.sockets[0]);
	const second = await h.request();
	await first.body!.cancel();
	assert.equal(h.sockets.length, 1);
	assert.equal(h.sockets[0].closed, 0);
	complete(h.sockets[0], "second_id");
	assert.match(await second.text(), /second_id/);
});

test("concurrent calls are isolated while opening and while streaming", async (t) => {
	const h = harness(t, { sessionId: "session", autoOpen: false });
	const pending1 = h.request();
	const pending2 = h.request();
	await until(() => h.sockets.length === 2);
	h.sockets[0].open();
	h.sockets[1].open();
	const [first, second] = await Promise.all([pending1, pending2]);
	const pending3 = h.request();
	await until(() => h.sockets.length === 3);
	h.sockets[2].open();
	const third = await pending3;
	for (let i = 0; i < 3; i++) complete(h.sockets[i], `resp_${i}`);
	assert.match(await first.text(), /resp_0/);
	assert.match(await second.text(), /resp_1/);
	assert.match(await third.text(), /resp_2/);
	assert.equal(h.sockets.filter((socket) => !socket.closed).length, 1, "only one idle socket retained per fingerprint");
});

test("fingerprint separates sessions, URLs, auth and custom headers", async (t) => {
	const h = harness(t, { sessionId: "session" });
	const variants: [typeof fetch, string, HeadersInit][] = [
		[h.fetch, endpoint, dummyHeaders],
		[h.fetch, endpoint, { ...dummyHeaders, authorization: "Bearer different-dummy" }],
		[h.fetch, endpoint, { ...dummyHeaders, "x-custom": "dummy" }],
		[h.fetch, endpoint.replace("route=test", "route=other"), dummyHeaders],
		[h.transport.createFetch({ ...h.options, sessionId: "other-session" }), endpoint, dummyHeaders],
	];
	for (let index = 0; index < variants.length; index++) {
		const [fetch, url, headers] = variants[index];
		const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "dummy", input }) });
		assert.equal(h.sockets.length, index + 1);
		complete(h.sockets[index]);
		await response.text();
	}
});

test("idle session sockets expire, and remote idle closure is cleaned immediately", async (t) => {
	const h = harness(t, { sessionId: "session", idleTimeoutMs: 10 });
	const first = await h.request();
	complete(h.sockets[0]);
	await first.text();
	await until(() => h.sockets[0].closed === 1);
	assert.equal(h.sockets[0].listenerCount, 0);
	const second = await h.request();
	complete(h.sockets[1]);
	await second.text();
	h.sockets[1].remoteClose();
	assert.equal(h.sockets[1].listenerCount, 0);
});

test("close shuts down opening, active and idle sockets; permanently rejects future work", async (t) => {
	const opening = harness(t, { transport: "auto", autoOpen: false });
	const pending = opening.request();
	await until(() => opening.sockets.length === 1);
	opening.transport.close();
	await assert.rejects(pending, /closed/);
	assert.equal(opening.fallbacks.length, 0);
	const active = harness(t, { sessionId: "session" });
	const response = await active.request();
	active.transport.close();
	await assert.rejects(response.text(), /closed/);
	await assert.rejects(active.request(), /closed/);
	active.transport.close();
	assert.equal(active.sockets[0].closed, 1);
});

async function cachedFirst(h: ReturnType<typeof harness>) {
	const response = await h.request();
	complete(h.sockets[0]);
	await response.text();
	return { model: "dummy", input: [...input, ...output, { role: "user", content: "next" }], stream: true };
}

test("cached mode sends only exact-prefix delta on same connection", async (t) => {
	const h = harness(t, { transport: "websocket-cached", sessionId: "session" });
	const body = await cachedFirst(h);
	const response = await h.request(body);
	assert.equal(h.sockets.length, 1);
	assert.deepEqual(h.sockets[0].sent[1], { model: "dummy", input: [{ role: "user", content: "next" }], previous_response_id: "resp_1", type: "response.create" });
	complete(h.sockets[0], "resp_2");
	await response.text();
});

test("auto mode reuses connections but never implicitly enables cached-context optimization", async (t) => {
	const h = harness(t, { transport: "auto", sessionId: "session" });
	const body = await cachedFirst(h);
	const response = await h.request(body);
	assert.equal(h.sockets.length, 1);
	assert.deepEqual(h.sockets[0].sent[1].input, body.input);
	assert.equal(h.sockets[0].sent[1].previous_response_id, undefined);
	complete(h.sockets[0]);
	await response.text();
});

test("cached mode without a session closes each request and sends full context", async (t) => {
	const h = harness(t, { transport: "websocket-cached" });
	const body = await cachedFirst(h);
	const response = await h.request(body);
	assert.equal(h.sockets.length, 2);
	assert.equal(h.sockets[0].closed, 1);
	assert.deepEqual(h.sockets[1].sent[0].input, body.input);
	assert.equal(h.sockets[1].sent[0].previous_response_id, undefined);
	complete(h.sockets[1]);
	await response.text();
	assert.equal(h.sockets[1].closed, 1);
});

test("cached mode falls back to full body when prefix/options differ or caller supplies previous_response_id", async (t) => {
	for (const change of [
		(body: Record<string, unknown>) => ({ ...body, input: [{ role: "user", content: "edited" }] }),
		(body: Record<string, unknown>) => ({ ...body, model: "other" }),
		(body: Record<string, unknown>) => ({ ...body, tools: [{ type: "function", name: "different" }] }),
		(body: Record<string, unknown>) => ({ ...body, previous_response_id: "caller_id" }),
	]) {
		const h = harness(t, { transport: "websocket-cached", sessionId: "session" });
		const body: Record<string, unknown> = change(await cachedFirst(h));
		const response = await h.request(body);
		const { stream: _stream, ...expected } = body;
		assert.deepEqual(h.sockets[0].sent[1], { ...expected, type: "response.create" });
		complete(h.sockets[0]);
		await response.text();
	}
});

test("cache is scoped to a connection, not merely a session", async (t) => {
	const h = harness(t, { transport: "websocket-cached", sessionId: "session" });
	const body = await cachedFirst(h);
	h.sockets[0].remoteClose();
	const response = await h.request(body);
	assert.equal(h.sockets.length, 2);
	assert.equal(h.sockets[1].sent[0].previous_response_id, undefined);
	assert.deepEqual(h.sockets[1].sent[0].input, body.input);
	complete(h.sockets[1]);
	await response.text();
});

test("missing generated previous_response_id retries once on fresh WS with full context before output", async (t) => {
	const h = harness(t, { transport: "websocket-cached", sessionId: "session" });
	const body = await cachedFirst(h);
	const response = await h.request(body);
	h.sockets[0].message({ type: "response.created", response: { id: "discarded_id" } });
	h.sockets[0].message({ type: "codex.rate_limits", rate_limits: {} });
	h.sockets[0].message({ type: "codex.response.metadata", metadata: {} });
	h.sockets[0].message({ type: "error", error: { code: "previous_response_not_found" } });
	await until(() => h.sockets.length === 2 && h.sockets[1].sent.length === 1);
	assert.equal(h.sockets[0].closed, 1);
	assert.equal(h.sockets[1].sent[0].previous_response_id, undefined);
	assert.deepEqual(h.sockets[1].sent[0].input, body.input);
	complete(h.sockets[1], "fresh_id");
	const text = await response.text();
	assert.doesNotMatch(text, /discarded_id/);
	assert.match(text, /fresh_id/);
	assert.equal(h.fallbacks.length, 0);
});

test("cache retry is not repeated, not allowed after output, and never used for explicit caller continuation", async (t) => {
	for (const scenario of ["twice", "output", "explicit"] as const) {
		const h = harness(t, { transport: "websocket-cached", sessionId: "session" });
		const body: Record<string, unknown> = await cachedFirst(h);
		if (scenario === "explicit") body.previous_response_id = "caller_id";
		const response = await h.request(body);
		const reader = response.body!.getReader();
		if (scenario === "output") {
			h.sockets[0].message({ type: "response.output_text.delta", delta: "accepted" });
			await reader.read();
		}
		h.sockets[0].message({ type: "error", code: "previous_response_not_found" });
		if (scenario === "twice") {
			await until(() => h.sockets.length === 2 && h.sockets[1].sent.length === 1);
			h.sockets[1].message({ type: "error", code: "previous_response_not_found" });
		}
		await assert.rejects(reader.read(), /previous_response_not_found/);
		assert.equal(h.sockets.length, scenario === "twice" ? 2 : 1);
		assert.equal(h.fallbacks.length, 0);
	}
});

test("consumer cancellation during cached reconnect cancels the opening socket immediately", async (t) => {
	const h = harness(t, { transport: "websocket-cached", sessionId: "session", autoOpen: false, connectTimeoutMs: 0 });
	const pending = h.request();
	await until(() => h.sockets.length === 1);
	h.sockets[0].open();
	const first = await pending;
	complete(h.sockets[0]);
	await first.text();
	const second = await h.request({ model: "dummy", input: [...input, ...output, { role: "user", content: "next" }] });
	h.sockets[0].message({ type: "error", code: "previous_response_not_found" });
	await until(() => h.sockets.length === 2);
	await second.body!.cancel();
	assert.equal(h.sockets[1].closed, 1);
	assert.equal(h.sockets[1].listenerCount, 0);
	assert.equal(h.fallbacks.length, 0);
});

function frame(text: string): Buffer {
	const data = Buffer.from(text);
	const header = Buffer.alloc(data.length < 126 ? 2 : 4);
	header[0] = 0x81;
	if (data.length < 126) header[1] = data.length;
	else { header[1] = 126; header.writeUInt16BE(data.length, 2); }
	return Buffer.concat([header, data]);
}

async function localServer(t: TestContext) {
	const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { server, base: `http://127.0.0.1:${address.port}` };
}

test("Node 24 native WS actually forwards dummy handshake headers and sends response.create over WS", async (t) => {
	const { server, base } = await localServer(t);
	let handshake: { url?: string; headers: Record<string, unknown> } | undefined;
	let wireRequest: Record<string, unknown> | undefined;
	server.on("upgrade", (request, socket) => {
		handshake = { url: request.url, headers: request.headers };
		const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		let bytes = Buffer.alloc(0);
		socket.on("data", (data: Buffer) => {
			bytes = Buffer.concat([bytes, data]);
			if (bytes.length < 2) return;
			if ((bytes[0] & 0x0f) === 8) { socket.end(Buffer.from([0x88, 0])); return; }
			let length = bytes[1] & 0x7f;
			let offset = 2;
			if (length === 126) { if (bytes.length < 4) return; length = bytes.readUInt16BE(2); offset = 4; }
			assert.notEqual(length, 127);
			assert.ok(bytes[1] & 0x80, "client frame is masked");
			if (bytes.length < offset + 4 + length) return;
			const mask = bytes.subarray(offset, offset + 4);
			const payload = Buffer.from(bytes.subarray(offset + 4, offset + 4 + length));
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
			bytes = bytes.subarray(offset + 4 + length);
			wireRequest = JSON.parse(payload.toString());
			socket.write(Buffer.concat([
				frame(JSON.stringify({ type: "response.output_text.delta", delta: "native hello" })),
				frame(JSON.stringify({ type: "response.completed", response: { id: "local_1", status: "completed", output: [] } })),
			]));
		});
	});
	let fallbackCalls = 0;
	const transport = new ResponsesWebSocketTransport();
	t.after(() => transport.close());
	const fetch = transport.createFetch({ transport: "websocket", connectTimeoutMs: 1000, idleTimeoutMs: 1000,
		fallbackFetch: async () => { fallbackCalls++; throw new Error("unexpected HTTP fallback"); } });
	const response = await fetch(`${base}/v1/responses?dummy=1`, { method: "POST", headers: {
		...dummyHeaders, "x-custom-dummy": "custom-value", accept: "text/event-stream", "content-length": "999",
	}, body: JSON.stringify({ model: "dummy", input, stream: true, background: false }) });
	assert.match(await response.text(), /native hello/);
	assert.equal(handshake?.url, "/v1/responses?dummy=1");
	assert.equal(handshake?.headers.authorization, "Bearer dummy-test-key");
	assert.equal(handshake?.headers["x-custom-dummy"], "custom-value");
	assert.equal(handshake?.headers["content-type"], undefined);
	assert.equal(handshake?.headers["content-length"], undefined);
	assert.notEqual(handshake?.headers.accept, "text/event-stream");
	assert.deepEqual(wireRequest, { model: "dummy", input, type: "response.create" });
	assert.equal(fallbackCalls, 0);
});

test("native WS handshake does not follow redirects or leak headers to redirect target", async (t) => {
	const source = await localServer(t);
	const target = await localServer(t);
	let targetCalls = 0;
	target.server.on("request", () => targetCalls++);
	target.server.on("upgrade", (_request, socket) => { targetCalls++; socket.end(); });
	source.server.on("upgrade", (_request, socket) => {
		socket.end(`HTTP/1.1 302 Found\r\nLocation: ${target.base}/v1/responses\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
	});
	const transport = new ResponsesWebSocketTransport();
	t.after(() => transport.close());
	const fetch = transport.createFetch({ transport: "websocket", connectTimeoutMs: 1000,
		fallbackFetch: async () => { throw new Error("unexpected HTTP fallback"); } });
	await assert.rejects(fetch(`${source.base}/v1/responses`, { method: "POST", headers: dummyHeaders, body: "{}" }), /handshake failed/);
	await delay(10);
	assert.equal(targetCalls, 0);
});
