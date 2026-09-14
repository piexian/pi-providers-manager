import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TransportConfigStore } from "../src/transport-config.ts";
import { applyTransportOptions, registerProviderTransports, delegateStream } from "../src/provider-transport-runtime.ts";
import { ResponsesWebSocketTransport } from "../src/responses-websocket.ts";

type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
type Options = NonNullable<Parameters<Provider["streamSimple"]>[2]>;
const model = { provider: "cpa", id: "dummy-model", name: "Dummy", api: "openai-responses", baseUrl: "https://offline.invalid/v1", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Parameters<Provider["streamSimple"]>[0];
const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as Parameters<Provider["streamSimple"]>[1];
const sentinel = {} as ReturnType<Provider["streamSimple"]>;

function fixture(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-transport-runtime-test-"));
	t.after(() => { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
	const store = new TransportConfigStore(join(dir, "provider-transports.json"));
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const registered = new Map<string, { api: string; streamSimple: Provider["streamSimple"] }>();
	const native = new Map<string, Provider>();
	const notices: string[] = [];
	const session = { id: "session-1", entries: [] as { type: string; customType: string; data: unknown }[] };
	const calls: { model: typeof model; options: Options; full?: boolean }[] = [];
	const makeBase = (id: string): Provider => ({
		id, getModels: () => [{ ...model, provider: id }],
		streamSimple: (m: typeof model, _c: typeof context, options: Options) => { calls.push({ model: m, options }); return sentinel; },
		stream: (m: typeof model, _c: typeof context, options: Options) => { calls.push({ model: m, options, full: true }); return sentinel; },
	} as unknown as Provider);
	const bases = new Map(["cpa", "other"].map((id) => [id, makeBase(id)]));
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
		registerProvider: (id: string, config: { api: string; streamSimple: Provider["streamSimple"] }) => registered.set(id, config),
		unregisterProvider: (id: string) => registered.delete(id),
		appendEntry: (customType: string, data: unknown) => session.entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: dir, isProjectTrusted: () => false,
		ui: { notify: (message: string) => notices.push(message) },
		sessionManager: { getSessionId: () => session.id, getEntries: () => session.entries },
		modelRegistry: {
			getProvider: (id: string) => bases.get(id),
			getRegisteredProviderConfig: (id: string) => registered.get(id),
			getRegisteredNativeProvider: (id: string) => native.get(id),
		},
	} as unknown as ExtensionContext;
	registerProviderTransports(pi, store);
	t.after(() => handlers.get("session_shutdown")?.({}, ctx));
	return { dir, store, handlers, registered, native, notices, calls, bases, pi, ctx, session, start: () => handlers.get("session_start")!({}, ctx), stop: () => handlers.get("session_shutdown")!({}, ctx) };
}

function fallbackProbe(t: TestContext, f: ReturnType<typeof fixture>) {
	let httpRequests = 0;
	t.mock.method(ResponsesWebSocketTransport.prototype, "createFetch", (options: Parameters<ResponsesWebSocketTransport["createFetch"]>[0]) => {
		return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			options.onFallback?.("WebSocket connect timeout (60 ms)");
			return options.fallbackFetch(input, init);
		};
	});
	return {
		get httpRequests() { return httpRequests; },
		async request(id = "cpa") {
			f.registered.get(id)!.streamSimple({ ...model, provider: id }, context, {
				fetch: async () => { httpRequests++; return new Response("OK"); },
			});
			return (await f.calls.at(-1)!.options.fetch!("https://offline.invalid/v1/responses")).text();
		},
	};
}

test("fallback warns once per session across concurrent requests and providers, without suppressing SSE requests", async (t) => {
	const f = fixture(t);
	for (const id of ["cpa", "other"]) f.store.updateProvider(id, (p) => { p.transport = "auto"; p.httpIdleTimeoutMs = 0; });
	f.start();
	const probe = fallbackProbe(t, f);
	assert.deepEqual(await Promise.all([probe.request(), probe.request(), probe.request("other")]), ["OK", "OK", "OK"]);
	assert.equal(probe.httpRequests, 3);
	assert.equal(f.notices.length, 1);
	assert.match(f.notices[0], /connect timeout \(60 ms\)/);
	assert.deepEqual(f.session.entries, [{ type: "custom", customType: "providers-manager:transport-fallback-warning", data: { sessionId: "session-1", provider: "cpa" } }]);
});

test("reload/resume preserves the warning marker; a new or forked session warns again", async (t) => {
	const f = fixture(t);
	f.store.updateProvider("cpa", (p) => { p.transport = "auto"; p.httpIdleTimeoutMs = 0; });
	f.start();
	const probe = fallbackProbe(t, f);
	await probe.request();
	f.stop();
	f.session.entries = JSON.parse(JSON.stringify(f.session.entries));
	registerProviderTransports(f.pi, f.store);
	f.start();
	await probe.request();
	assert.equal(f.notices.length, 1);
	assert.equal(f.session.entries.length, 1);
	f.stop();
	f.session.id = "forked-session";
	registerProviderTransports(f.pi, f.store);
	f.start();
	await probe.request();
	assert.equal(f.notices.length, 2);
	assert.equal(f.session.entries.length, 2);
	assert.equal(probe.httpRequests, 3);
});

test("without settings no provider is registered or changed", (t) => {
	const f = fixture(t); f.start();
	assert.equal(f.registered.size, 0);
	assert.deepEqual(readdirSync(f.dir), []);
});

test("provider registration contains no copied catalog, credentials or endpoint; shutdown removes only owned wrapper", (t) => {
	const f = fixture(t);
	f.store.updateProvider("cpa", (p) => { p.transport = "sse"; p.httpIdleTimeoutMs = 0; });
	f.start();
	const registration = f.registered.get("cpa")!;
	assert.deepEqual(Object.keys(registration).sort(), ["api", "streamSimple"]);
	assert.equal(f.registered.has("other"), false);
	assert.equal(registration.streamSimple(model, context, { apiKey: "dummy", sessionId: "test" }), sentinel);
	assert.equal(f.calls[0].model, model);
	assert.equal(f.calls[0].options.apiKey, "dummy");
	assert.equal(f.calls[0].options.transport, "sse");
	f.stop();
	assert.equal(f.registered.size, 0);
	f.stop();
});

test("a different extension's registration is preserved during startup and shutdown", (t) => {
	const f = fixture(t);
	f.store.updateProvider("cpa", (p) => { p.transport = "websocket"; });
	f.native.set("cpa", f.bases.get("cpa")!);
	f.start();
	assert.equal(f.registered.size, 0);
	assert.ok(f.notices.some((notice) => notice.includes("其他扩展")));
	f.native.clear(); f.start();
	const replacement = { api: "openai-responses", streamSimple: (() => sentinel) as Provider["streamSimple"] };
	f.registered.set("cpa", replacement);
	f.stop();
	assert.equal(f.registered.get("cpa"), replacement);
});

test("one malformed provider cannot disable valid strict WS; invalid provider fails closed", (t) => {
	const f = fixture(t);
	writeFileSync(f.store.path, JSON.stringify({ providers: { cpa: { transport: "websocket" }, other: { httpIdleTimeoutMs: -1 } } }));
	f.start();
	assert.equal(f.registered.size, 2);
	assert.equal(f.registered.get("cpa")!.streamSimple(model, context, {}), sentinel);
	assert.equal(f.calls[0].options.transport, "websocket");
	assert.throws(() => f.registered.get("other")!.streamSimple({ ...model, provider: "other" }, context, {}), /禁止回退/);
	assert.equal(f.calls.length, 1);
});

test("settings snapshot changes only after reload, and timeout overrides retain zero", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.dir, "settings.json"), JSON.stringify({ websocketConnectTimeoutMs: 4321, httpIdleTimeoutMs: 999 }));
	f.store.updateProvider("cpa", (p) => { p.transport = "sse"; p.httpIdleTimeoutMs = 0; });
	f.start();
	f.store.updateProvider("cpa", (p) => { p.transport = "websocket"; });
	f.registered.get("cpa")!.streamSimple(model, context, {});
	assert.equal(f.calls[0].options.transport, "sse");
	assert.equal(f.calls[0].options.websocketConnectTimeoutMs, 4321);
	assert.equal(f.calls[0].options.fetch, globalThis.fetch);
});

test("strict Codex blocks its native HTTP fallback; unsupported strict API cannot call fetch", async () => {
	const bridge = new ResponsesWebSocketTransport();
	try {
		const options = applyTransportOptions("openai-codex-responses", { transport: "websocket", httpIdleTimeoutMs: 0 }, {}, {}, bridge, () => {});
		assert.equal(options.timeoutMs, 0);
		await assert.rejects(options.fetch!("https://offline.invalid"), /禁止 Codex 回退/);
		assert.throws(() => applyTransportOptions("anthropic-messages", { transport: "websocket" }, {}, {}, bridge, () => {}), /没有 WS 适配/);
	} finally { bridge.close(); }
});

test("API-specific options use full stream instead of discarding service tier or reasoning effort", (t) => {
	const f = fixture(t);
	delegateStream(f.bases.get("cpa")!, model, context, { serviceTier: "priority", reasoningEffort: "high" } as Options);
	assert.equal(f.calls[0].full, true);
});

const piRoot = process.env.PI_TEST_PACKAGE_DIR ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const aiRoot = join(piRoot, "node_modules/@earendil-works/pi-ai/dist");
const responses = await import(pathToFileURL(join(aiRoot, "api/openai-responses.js")).href);
const overflow = await import(pathToFileURL(join(aiRoot, "utils/overflow.js")).href);

class WireSocket extends EventTarget {
	readyState = 1;
	binaryType = "arraybuffer";
	sent: Record<string, unknown>[] = [];
	respond: (socket: WireSocket, body: Record<string, unknown>) => void = () => {};
	send(text: string) { const body = JSON.parse(text); this.sent.push(body); queueMicrotask(() => this.respond(this, body)); }
	message(event: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
	close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

test("actual Pi serializer/parser round-trips tool calls, reasoning, replay and usage over the WS bridge", async () => {
	const socket = new WireSocket();
	const bridge = new ResponsesWebSocketTransport(() => socket);
	const requests: Record<string, unknown>[] = [];
	const reasoning = { type: "reasoning", id: "rs_test", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "dummy-signature" };
	const tool = { type: "function_call", id: "fc_test", call_id: "call_test", name: "lookup", arguments: '{"q":"test"}' };
	const text = { type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] };
	socket.respond = (ws, body) => {
		requests.push(body);
		const output = requests.length === 1 ? [reasoning, tool] : [text];
		ws.message({ type: "response.created", response: { id: "resp_test", status: "in_progress" } });
		output.forEach((item, output_index) => {
			ws.message({ type: "response.output_item.added", output_index, item: { ...item, ...("arguments" in item ? { arguments: "" } : {}) } });
			ws.message({ type: "response.output_item.done", output_index, item });
		});
		ws.message({ type: "response.completed", response: { id: "resp_test", status: "completed", output, usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } } });
	};
	try {
		const options = applyTransportOptions("openai-responses", { transport: "websocket" }, {}, { apiKey: "dummy", sessionId: "sdk-test", reasoning: "high", maxRetries: 0 }, bridge, () => assert.fail("no fallback"));
		const first = await responses.streamSimple(model, { ...context, tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }] }, options).result();
		assert.equal(first.stopReason, "toolUse", first.errorMessage);
		assert.equal(first.content[0].type, "thinking");
		assert.equal(first.content[0].thinking, "thinking");
		const call = first.content.find((item: { type: string }) => item.type === "toolCall");
		assert.deepEqual(call.arguments, { q: "test" });
		assert.equal(first.usage.cacheRead, 4);
		assert.equal(first.usage.output, 5);
		const second = await responses.streamSimple(model, { messages: [...context.messages, first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "found" }], isError: false, timestamp: 1 }] }, options).result();
		assert.equal(second.stopReason, "stop", second.errorMessage);
		assert.equal(second.content[0].text, "OK");
		assert.equal(socket.sent.length, 2);
		assert.equal(requests[0].type, "response.create");
		assert.equal(requests[0].stream, undefined);
		assert.equal((requests[0].reasoning as { effort: string }).effort, "high");
		assert.ok(JSON.stringify(requests[1].input).includes("function_call_output"));
	} finally { bridge.close(); }
});

test("actual Pi overflow detection survives WS error redaction without exposing server payload", async () => {
	const socket = new WireSocket();
	socket.respond = (ws) => ws.message({ type: "error", error: { code: "context_length_exceeded", message: "dummy-secret-server-message" } });
	const bridge = new ResponsesWebSocketTransport(() => socket);
	try {
		const options = applyTransportOptions("openai-responses", { transport: "websocket" }, {}, { apiKey: "dummy", maxRetries: 0 }, bridge, () => {});
		const result = await responses.streamSimple(model, context, options).result();
		assert.equal(result.stopReason, "error");
		assert.ok(overflow.isContextOverflow(result));
		assert.doesNotMatch(result.errorMessage, /dummy-secret-server-message/);
	} finally { bridge.close(); }
});
