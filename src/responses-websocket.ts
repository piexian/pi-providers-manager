import { createHash } from "node:crypto";

export interface ResponsesWebSocketOptions {
	transport: "auto" | "websocket" | "websocket-cached";
	sessionId?: string;
	connectTimeoutMs?: number;
	idleTimeoutMs?: number;
	fallbackFetch: typeof globalThis.fetch;
	onFallback?: (reason: string) => void;
}

export interface ResponsesWebSocket {
	readonly readyState: number;
	binaryType: string;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
}

export type ResponsesWebSocketFactory = (
	url: string,
	options: { headers: Record<string, string> },
) => ResponsesWebSocket;

type Body = Record<string, unknown>;
type Continuation = { body: Body; id: string; output: unknown[] };
type Connection = {
	socket: ResponsesWebSocket;
	key?: string;
	busy: boolean;
	disposed: boolean;
	continuation?: Continuation;
	timer?: ReturnType<typeof setTimeout>;
	fail?: (error: Error) => void;
	message?: (event: MessageEvent) => void;
	listeners: [string, EventListener][];
};

class ConnectFailure extends Error {}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function nativeFactory(url: string, options: { headers: Record<string, string> }): ResponsesWebSocket {
	// Node 24's extended constructor forwards headers and uses redirect: "error".
	const Constructor = globalThis.WebSocket as unknown as new (
		url: string,
		options: { headers: Record<string, string> },
	) => ResponsesWebSocket;
	return new Constructor(url, options);
}

function timeout(value: number | undefined, defaultValue: number): number {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
		throw new Error("WebSocket timeout must be finite and between 0 and 2147483647 milliseconds");
	}
	return Math.ceil(value);
}

function aborted(signal?: AbortSignal): Error {
	return signal?.reason instanceof Error ? signal.reason : new DOMException("Request aborted", "AbortError");
}

function object(value: unknown): value is Body {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMetadataNotification(data: unknown): boolean {
	try {
		const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? decoder.decode(data)
			: ArrayBuffer.isView(data) ? decoder.decode(data) : undefined;
		const type = text === undefined ? undefined : JSON.parse(text)?.type;
		return typeof type === "string" && type.length > 0 && type !== "error" && !type.startsWith("response.");
	} catch { return false; }
}

function socketHeaders(source: Headers): Record<string, string> {
	const headers = new Headers(source);
	const framing = ["host", "connection", "upgrade", "content-length", "content-type", "content-encoding",
		"accept", "accept-encoding", "transfer-encoding", "te", "trailer", "keep-alive", "proxy-authorization", "proxy-connection"];
	// Connection can nominate additional hop-by-hop headers.
	for (const name of (headers.get("connection") ?? "").split(",")) {
		if (name.trim()) headers.delete(name.trim());
	}
	for (const name of [...headers.keys()]) {
		if (framing.includes(name) || name.startsWith("sec-websocket-")) headers.delete(name);
	}
	return Object.fromEntries(headers);
}

function deltaBody(body: Body, previous?: Continuation): Body | undefined {
	if (!previous || body.previous_response_id !== undefined || !Array.isArray(body.input)
		|| !Array.isArray(previous.body.input)) return;
	const { input: _input, ...settings } = body;
	const { input: _previousInput, ...previousSettings } = previous.body;
	if (JSON.stringify(settings) !== JSON.stringify(previousSettings)) return;
	// Exact comparison deliberately favors full-context requests over ambiguous replay.
	const prefix = [...previous.body.input, ...previous.output];
	if (body.input.length < prefix.length
		|| JSON.stringify(body.input.slice(0, prefix.length)) !== JSON.stringify(prefix)) return;
	return { ...body, previous_response_id: previous.id, input: body.input.slice(prefix.length) };
}

const PROVIDER_ERRORS: Record<string, string> = {
	context_length_exceeded: "context_length_exceeded: input exceeds the context window",
	model_context_window_exceeded: "context_length_exceeded: input exceeds the context window",
	rate_limit_exceeded: "rate limit exceeded",
	insufficient_quota: "insufficient_quota",
	usage_limit_reached: "usage limit reached",
	server_error: "503 upstream server error",
	overloaded_error: "503 service unavailable",
	invalid_api_key: "invalid_api_key",
	authentication_error: "authentication_error",
	permission_denied: "permission_denied",
	model_not_found: "model_not_found",
	invalid_request_error: "invalid_request_error",
	previous_response_not_found: "previous_response_not_found",
	websocket_connection_limit_reached: "websocket_connection_limit_reached",
};
function providerError(error: Body, failed: boolean): Error {
	const code = typeof error.code === "string" ? error.code : "";
	if (Object.hasOwn(PROVIDER_ERRORS, code)) return new Error(PROVIDER_ERRORS[code]);
	return new Error(failed ? "WebSocket response failed" : "WebSocket server error");
}

/**
 * Lazy WebSocket-to-SSE adapter for the standard OpenAI Responses SDK parser.
 * Cached mode requires an exact wire-output prefix; serializer differences safely
 * reduce cache hits rather than guessing which context the server already has.
 * idleTimeoutMs covers both response inactivity and pooled-socket expiry (0 disables).
 * close() permanently disposes this transport; create a new instance to restart.
 */
export class ResponsesWebSocketTransport {
	private factory: ResponsesWebSocketFactory;
	private connections = new Set<Connection>();
	private closed = false;

	constructor(factory: ResponsesWebSocketFactory = nativeFactory) {
		this.factory = factory;
	}

	createFetch(options: ResponsesWebSocketOptions): typeof globalThis.fetch {
		const connectMs = timeout(options.connectTimeoutMs, 15_000);
		const idleMs = timeout(options.idleTimeoutMs, 300_000);
		if (!["auto", "websocket", "websocket-cached"].includes(options.transport)) {
			throw new Error("Unsupported WebSocket transport");
		}
		return async (input, init) => {
			if (this.closed) throw new Error("WebSocket transport is closed");
			let request: Request;
			try {
				// Leave the caller's Request body untouched for handshake-only HTTP fallback.
				request = new Request(input instanceof Request ? input.clone() : input, init);
			} catch {
				throw new Error("Invalid WebSocket Responses request");
			}
			const signal = request.signal;
			if (signal.aborted) throw aborted(signal);
			const url = new URL(request.url);
			if (request.method !== "POST" || !["http:", "https:"].includes(url.protocol)
				|| !url.pathname.endsWith("/responses") || url.username || url.password || url.hash) {
				throw new Error("WebSocket transport requires POST to an HTTP(S) /responses URL without URL credentials or fragment");
			}
			let body: unknown;
			try { body = JSON.parse(await request.text()); } catch {
				if (signal.aborted) throw aborted(signal);
				throw new Error("WebSocket Responses request must contain a JSON object");
			}
			if (!object(body)) throw new Error("WebSocket Responses request must contain a JSON object");
			delete body.stream;
			delete body.background;
			delete body.type;
			if (signal.aborted) throw aborted(signal);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			const headers = socketHeaders(request.headers);
			const traceHeaders = new Set(["x-client-request-id", "traceparent", "tracestate"]);
			const identityHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => !traceHeaders.has(name)));
			const group = options.sessionId ? createHash("sha256").update(JSON.stringify([options.sessionId, url.href])).digest("hex") : undefined;
			const key = group ? `${group}:${createHash("sha256").update(JSON.stringify(identityHeaders)).digest("hex")}` : undefined;
			let connection: Connection;
			try {
				connection = await this.acquire(url.href, headers, key, signal, connectMs);
			} catch (error) {
				if (options.transport !== "auto" || !(error instanceof ConnectFailure) || signal.aborted || this.closed) throw error;
				// Never include handshake URLs, headers, or runtime error payloads in notices.
				try { options.onFallback?.(`${error.message}; before request send; using HTTP SSE`); } catch { /* A notice must not break fallback. */ }
				if (signal.aborted) throw aborted(signal);
				if (this.closed) throw new Error("WebSocket transport is closed");
				return options.fallbackFetch(input, init);
			}
			return this.response(connection, body, signal, options.transport === "websocket-cached",
				idleMs, (retrySignal) => this.acquire(url.href, headers, key, retrySignal, connectMs, true));
		};
	}

	close(): void {
		this.closed = true;
		for (const entry of [...this.connections]) {
			entry.fail?.(new DOMException("WebSocket transport closed", "AbortError"));
			this.dispose(entry);
		}
	}

	private dispose(entry: Connection): void {
		if (entry.disposed) return;
		entry.disposed = true;
		clearTimeout(entry.timer);
		entry.continuation = undefined;
		entry.fail = undefined;
		entry.message = undefined;
		for (const [type, listener] of entry.listeners) entry.socket.removeEventListener(type, listener);
		entry.listeners.length = 0;
		this.connections.delete(entry);
		try { entry.socket.close(1000, "done"); } catch { /* Already closed. */ }
	}

	private release(entry: Connection, idleMs: number): void {
		entry.fail = undefined;
		entry.message = undefined;
		if (!entry.key || entry.disposed || entry.socket.readyState !== 1 || this.closed) {
			this.dispose(entry);
			return;
		}
		// Keep one idle connection per session/endpoint, including after credential or route changes.
		const group = entry.key.split(":")[0];
		for (const other of this.connections) {
			if (other !== entry && other.key?.split(":")[0] === group && !other.busy) this.dispose(other);
		}
		entry.busy = false;
		if (idleMs > 0) {
			entry.timer = setTimeout(() => this.dispose(entry), idleMs);
			entry.timer.unref?.();
		}
	}

	private async acquire(url: string, headers: Record<string, string>, key: string | undefined,
		signal: AbortSignal, connectMs: number, fresh = false): Promise<Connection> {
		if (signal.aborted) throw aborted(signal);
		if (this.closed) throw new Error("WebSocket transport is closed");
		if (key && !fresh) {
			for (const entry of this.connections) {
				if (entry.key !== key || entry.busy) continue;
				if (entry.socket.readyState !== 1) { this.dispose(entry); continue; }
				entry.busy = true;
				clearTimeout(entry.timer);
				return entry;
			}
		}
		let socket: ResponsesWebSocket;
		try { socket = this.factory(url, { headers }); } catch {
			throw new ConnectFailure("WebSocket connection could not be created");
		}
		socket.binaryType = "arraybuffer";
		const entry: Connection = { socket, key, busy: true, disposed: false, listeners: [] };
		this.connections.add(entry);
		const listen = (type: string, listener: EventListener) => {
			entry.listeners.push([type, listener]);
			socket.addEventListener(type, listener);
		};
		return new Promise<Connection>((resolve, reject) => {
			let opening = true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				socket.removeEventListener("open", onOpen);
			};
			entry.fail = (error) => {
				if (!opening) { this.dispose(entry); return; }
				opening = false;
				cleanup();
				this.dispose(entry);
				reject(error);
			};
			const onAbort = () => entry.fail?.(aborted(signal));
			const onOpen = () => {
				if (!opening) return;
				opening = false;
				cleanup();
				entry.fail = undefined;
				resolve(entry);
			};
			listen("error", () => {
				const error = opening ? new ConnectFailure("WebSocket handshake failed") : new Error("WebSocket connection error");
				if (entry.fail) entry.fail(error); else this.dispose(entry);
			});
			listen("close", () => {
				const error = opening ? new ConnectFailure("WebSocket closed during handshake") : new Error("WebSocket closed before terminal response");
				if (entry.fail) entry.fail(error); else this.dispose(entry);
			});
			listen("message", (event) => {
				if (entry.message) entry.message(event as MessageEvent);
				else if (isMetadataNotification((event as MessageEvent).data)) return;
				else if (entry.fail) entry.fail(new Error("Unexpected WebSocket message before request"));
				else this.dispose(entry);
			});
			listen("open", onOpen);
			signal.addEventListener("abort", onAbort, { once: true });
			if (connectMs > 0) timer = setTimeout(() => entry.fail?.(new ConnectFailure(`WebSocket connect timeout (${connectMs} ms)`)), connectMs);
			if (signal.aborted) onAbort();
			else if (socket.readyState === 1) onOpen();
			else if (socket.readyState > 1) entry.fail?.(new ConnectFailure("WebSocket closed during handshake"));
		});
	}

	private response(first: Connection, fullBody: Body, signal: AbortSignal, cached: boolean,
		idleMs: number, reconnect: (signal: AbortSignal) => Promise<Connection>): Response {
		const retryAbort = new AbortController();
		let entry = first;
		let finished = false;
		let retrying = false;
		let retried = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let controller: ReadableStreamDefaultController<Uint8Array>;
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			entry.fail = undefined;
			entry.message = undefined;
		};
		const fail = (error: Error, cancel = false) => {
			if (finished) return;
			finished = true;
			cleanup();
			retryAbort.abort(error);
			this.dispose(entry);
			if (!cancel) controller.error(error);
		};
		const onAbort = () => fail(aborted(signal));
		const resetTimer = () => {
			clearTimeout(timer);
			if (idleMs > 0) timer = setTimeout(() => fail(new Error("WebSocket idle timeout")), idleMs);
		};
		const enqueue = (event: Body) => {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			if ((controller.desiredSize ?? 0) < 0) throw new Error("WebSocket response buffer limit exceeded");
		};
		const start = (allowDelta: boolean) => {
			if (finished) { this.dispose(entry); return; }
			if (signal.aborted) { onAbort(); return; }
			if (entry.disposed || entry.socket.readyState !== 1) { fail(new Error("WebSocket closed before request send")); return; }
			const delta = cached && allowDelta ? deltaBody(fullBody, entry.continuation) : undefined;
			entry.continuation = undefined;
			let emitted = false;
			const prelude: Body[] = [];
			entry.fail = fail;
			entry.message = (message) => {
				if (finished || retrying) return;
				try {
					const data: unknown = message.data;
					const text = typeof data === "string" ? data
						: data instanceof ArrayBuffer ? decoder.decode(data)
						: ArrayBuffer.isView(data) ? decoder.decode(data) : undefined;
					if (text === undefined) throw new Error("Unsupported WebSocket message data");
					let event: unknown;
					try { event = JSON.parse(text); } catch { throw new Error("Invalid WebSocket JSON"); }
					if (!object(event) || typeof event.type !== "string" || !event.type) throw new Error("Invalid WebSocket response event");
					// Match Pi's parser: account/response metadata is not generated model output.
					if (event.type !== "error" && !event.type.startsWith("response.")) return;
					resetTimer();
					const error = object(event.error) ? event.error
						: object(event.response) && object(event.response.error) ? event.response.error : event;
					if (event.type === "error" || event.type === "response.failed") {
						if (delta && !emitted && !retried && error.code === "previous_response_not_found") {
							retried = true;
							retrying = true;
							clearTimeout(timer);
							this.dispose(entry);
							void reconnect(retryAbort.signal).then((next) => {
								entry = next;
								retrying = false;
								start(false);
							}, (error: unknown) => fail(error instanceof Error ? error : new Error("WebSocket cached-context reconnect failed")));
							return;
						}
						// Keep safe error categories so Pi can compact overflow and classify retries.
						throw providerError(error, event.type === "response.failed");
					}
					if (delta && !emitted && (event.type === "response.created" || event.type === "response.in_progress")) {
						if (prelude.length >= 32) throw new Error("Excessive WebSocket response prelude");
						prelude.push(event);
						return;
					}
					const terminal = event.type === "response.completed" || event.type === "response.incomplete";
					if (terminal && (!object(event.response) || !Array.isArray(event.response.output)
						|| event.response.status !== (event.type === "response.completed" ? "completed" : "incomplete"))) {
						throw new Error("Invalid WebSocket terminal response");
					}
					for (const pending of prelude.splice(0)) enqueue(pending);
					enqueue(event);
					emitted = true;
					if (terminal) {
						const response = event.response as Body;
						if (cached && event.type === "response.completed" && !fullBody.previous_response_id
							&& typeof response.id === "string" && response.id && Array.isArray(fullBody.input)) {
							entry.continuation = { body: fullBody, id: response.id, output: response.output as unknown[] };
						}
						finished = true;
						cleanup();
						controller.close();
						this.release(entry, idleMs);
					}
				} catch (error) { fail(error instanceof Error ? error : new Error("WebSocket protocol error")); }
			};
			resetTimer();
			try {
				// Once send is attempted, even a synchronous failure must never replay over HTTP.
				entry.socket.send(JSON.stringify({ ...(delta ?? fullBody), type: "response.create" }));
			} catch { fail(new Error("WebSocket request send failed")); }
		};
		const stream = new ReadableStream<Uint8Array>({
			start: (streamController) => {
				controller = streamController;
				signal.addEventListener("abort", onAbort, { once: true });
				start(true);
			},
			cancel: () => fail(new DOMException("Response body cancelled", "AbortError"), true),
		}, new ByteLengthQueuingStrategy({ highWaterMark: MAX_BUFFER_BYTES }));
		return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
	}
}
