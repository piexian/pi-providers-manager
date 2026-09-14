import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "comment-json";
import { TransportConfigStore, validateTransportSettings, type ProviderTransportSettings } from "./transport-config.ts";
import { ResponsesWebSocketTransport } from "./responses-websocket.ts";
import { withIdleTimeout } from "./idle-timeout-fetch.ts";

const FALLBACK_WARNING_ENTRY = "providers-manager:transport-fallback-warning";

type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
type StreamOptions = NonNullable<Parameters<Provider["streamSimple"]>[2]>;

function timeoutDefaults(agentDir: string, ctx: ExtensionContext, configDirName: string): ProviderTransportSettings {
	let defaults: ProviderTransportSettings = { websocketConnectTimeoutMs: 15_000, httpIdleTimeoutMs: 300_000 };
	const paths = [join(agentDir, "settings.json")];
	if (ctx.isProjectTrusted()) paths.push(join(ctx.cwd, configDirName, "settings.json"));
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const settings = parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
		const fields = Object.fromEntries(["websocketConnectTimeoutMs", "httpIdleTimeoutMs"]
			.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]));
		defaults = { ...defaults, ...validateTransportSettings(fields) };
	}
	return defaults;
}

/** The legacy extension hook receives both simple and API-specific option objects. */
export function delegateStream(base: Provider, model: Parameters<Provider["streamSimple"]>[0], context: Parameters<Provider["streamSimple"]>[1], options: StreamOptions) {
	const rawOptions = options as StreamOptions & Record<string, unknown>;
	const fullApiCall = ["reasoningEffort", "reasoningSummary", "textVerbosity", "serviceTier"].some((key) => Object.hasOwn(rawOptions, key));
	return fullApiCall ? base.stream(model, context, options) : base.streamSimple(model, context, options);
}

export function applyTransportOptions(modelApi: string, settings: ProviderTransportSettings, defaults: ProviderTransportSettings, options: StreamOptions, bridge: ResponsesWebSocketTransport, onFallback: (reason: string) => void): StreamOptions {
	const transport = settings.transport;
	const strict = transport === "websocket" || transport === "websocket-cached";
	const supported = modelApi === "openai-responses" || modelApi === "openai-codex-responses";
	if (strict && !supported) throw new Error(`${modelApi} 没有 WS 适配；请恢复继承或 SSE`);
	const idleMs = settings.httpIdleTimeoutMs ?? defaults.httpIdleTimeoutMs ?? 300_000;
	const connectMs = settings.websocketConnectTimeoutMs ?? options.websocketConnectTimeoutMs ?? defaults.websocketConnectTimeoutMs ?? 15_000;
	const next: StreamOptions = { ...options, websocketConnectTimeoutMs: connectMs };
	if (transport !== undefined) next.transport = transport;
	if (modelApi === "openai-codex-responses") next.timeoutMs = settings.httpIdleTimeoutMs ?? options.timeoutMs ?? idleMs;
	const fallbackFetch = withIdleTimeout(options.fetch ?? globalThis.fetch, idleMs);
	if (modelApi === "openai-responses" && transport && transport !== "sse") {
		next.fetch = bridge.createFetch({
			transport,
			sessionId: options.cacheRetention === "none" ? undefined : options.sessionId,
			connectTimeoutMs: connectMs,
			idleTimeoutMs: idleMs,
			fallbackFetch,
			onFallback,
		});
	} else if (modelApi === "openai-codex-responses" && strict) {
		// Native Codex may attempt SSE even in websocket mode; block that network path.
		next.fetch = async () => { throw new Error("严格 WS 模式禁止 Codex 回退 HTTP/SSE"); };
	} else {
		next.fetch = fallbackFetch;
	}
	return next;
}

/** Register only isolated models.json providers; never overwrite another extension's provider. */
export function registerProviderTransports(pi: ExtensionAPI, store: TransportConfigStore, configDirName = ".pi"): void {
	const owned = new Map<string, Provider["streamSimple"]>();
	const bridge = new ResponsesWebSocketTransport();
	let registry: ExtensionContext["modelRegistry"] | undefined;
	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
		let settingsByProvider: Record<string, unknown>;
		let defaults: ProviderTransportSettings;
		try {
			settingsByProvider = store.readEntries();
			if (!Object.keys(settingsByProvider).length) return;
			defaults = timeoutDefaults(dirname(store.path), ctx, configDirName);
		} catch {
			ctx.ui.notify(`供应商传输配置无效，未启用覆盖；请检查 ${store.path}`, "error");
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		// Persist across reload/resume and branches, but not into a new or forked session.
		let fallbackWarned = ctx.sessionManager.getEntries().some((entry) => entry.type === "custom"
			&& entry.customType === FALLBACK_WARNING_ENTRY && entry.data !== null && typeof entry.data === "object"
			&& (entry.data as { sessionId?: unknown }).sessionId === sessionId);
		for (const [id, rawSettings] of Object.entries(settingsByProvider)) {
			let settings: ProviderTransportSettings = {};
			let configError = false;
			try { settings = validateTransportSettings(rawSettings); }
			catch { configError = true; }
			if (!configError && !Object.keys(settings).length) continue;
			const base = registry.getProvider(id);
			if (!base) { ctx.ui.notify(`${id}: 供应商不存在，传输设置未启用`, "warning"); continue; }
			if (registry.getRegisteredProviderConfig(id) || registry.getRegisteredNativeProvider(id)) {
				ctx.ui.notify(`${id}: 已由其他扩展注册，未覆盖其传输；请由原扩展配置`, "error");
				continue;
			}
			const apis = [...new Set(base.getModels().map((model) => model.api))];
			if (apis.length !== 1) {
				ctx.ui.notify(`${id}: 当前需单一 API 类型才能启用供应商传输设置；混合 API 请拆分供应商`, "error");
				continue;
			}
			const api = apis[0];
			if (configError) ctx.ui.notify(`${id}: 传输设置无效，已阻止该供应商请求；请修正配置后 /reload`, "error");
			const wrapper: Provider["streamSimple"] = (model, context, options = {}) => {
				if (configError) throw new Error(`${id}: 传输设置无效，禁止回退原始传输；请修正 ${store.path} 后 /reload`);
				return delegateStream(base, model, context, applyTransportOptions(model.api, settings, defaults, options, bridge, (reason) => {
					if (fallbackWarned) return;
					fallbackWarned = true;
					ctx.ui.notify(`${id}: WS 尚未发送请求，本次回退 SSE；原因：${reason}`, "warning");
					pi.appendEntry(FALLBACK_WARNING_ENTRY, { sessionId, provider: id });
				}));
			};
			pi.registerProvider(id, { api, streamSimple: wrapper });
			owned.set(id, wrapper);
		}
	});
	pi.on("session_shutdown", () => {
		bridge.close();
		for (const [id, wrapper] of owned) {
			if (registry?.getRegisteredProviderConfig(id)?.streamSimple === wrapper) pi.unregisterProvider(id);
		}
		owned.clear();
	});
}
