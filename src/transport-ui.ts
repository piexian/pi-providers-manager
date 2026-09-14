import { TRANSPORTS, TransportConfigStore, isResponsesApi, type Transport } from "./transport-config.ts";

type Item = { value: string; label: string; description?: string };
export interface TransportUI {
	pick(title: string, items: Item[]): Promise<string | null>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type: "info" | "warning" | "error"): void;
}
const DESCRIPTIONS: Record<Transport, string> = {
	auto: "Responses 优先 WS；仅握手失败且未发送请求时回退 SSE，并提示原因",
	sse: "使用原有 HTTP/SSE 链路，不尝试 WS",
	websocket: "严格 WS，全量上下文；连接失败报错，不回退 SSE",
	"websocket-cached": "严格 WS，安全匹配时复用连接上的上下文；失败不回退 SSE",
};

export async function editProviderTransport(ui: TransportUI, store: TransportConfigStore, providerId: string, apis: string[]): Promise<void> {
	const unsupported = [...new Set(apis.filter((api) => !isResponsesApi(api)))];
	if (unsupported.length) ui.notify(`保留这些 API 的原生传输与思考参数；本插件不应用传输/超时覆盖: ${unsupported.join(", ")}`, "warning");
	for (;;) {
		const settings = store.readProvider(providerId);
		const action = await ui.pick(`${providerId} 传输设置（保存后 /reload 生效）`, [
			{ value: "transport", label: `transport: ${settings.transport ?? "(继承 Pi，不接管传输)"}`, description: unsupported.length ? `保留原生传输，仅可清空旧覆盖: ${unsupported.join(", ")}` : "适用于该供应商的全部模型；不改变 API 类型和凭据" },
			{ value: "websocketConnectTimeoutMs", label: `WS 握手超时: ${settings.websocketConnectTimeoutMs ?? "(继承 Pi，默认 15000)"} ms`, description: "0 禁用；留空清除供应商覆盖" },
			{ value: "httpIdleTimeoutMs", label: `请求/流空闲超时: ${settings.httpIdleTimeoutMs ?? "(继承 Pi，默认 300000)"} ms`, description: "同时覆盖 SDK 请求超时与流空闲间隔；0 禁用，调用方 AbortSignal 仍有效" },
		]);
		if (action === null) return;
		if (action === "transport") {
			const mode = await ui.pick("传输方式", [
				{ value: "", label: "继承 Pi（不接管传输）", description: "删除该供应商的 transport 覆盖；普通 Responses 在 Pi 0.85.1 中仍为 SSE" },
				...TRANSPORTS.map((value) => ({ value, label: value, description: DESCRIPTIONS[value] })),
			]);
			if (mode === null) continue;
			if (mode !== "" && !(TRANSPORTS as readonly string[]).includes(mode)) continue;
			if (mode && (new Set(apis).size !== 1 || unsupported.length)) {
				ui.notify("仅单一 Responses API 可应用传输覆盖；其他 API 保留原生入口", "error");
				continue;
			}
			store.updateProvider(providerId, (p) => { if (mode) p.transport = mode as Transport; else delete p.transport; });
		} else if (action === "websocketConnectTimeoutMs" || action === "httpIdleTimeoutMs") {
			const current = settings[action];
			const value = await ui.input(`${action}（整数毫秒；0 禁用；留空继承 Pi）:`, current === undefined ? "" : String(current));
			if (value === undefined) continue;
			const trimmed = value.trim();
			if (trimmed && (unsupported.length || new Set(apis).size !== 1)) {
				ui.notify("此 API 保留原生超时；可清空旧覆盖", "error");
				continue;
			}
			if (trimmed && (!/^\d+$/.test(trimmed) || Number(trimmed) > 2_147_483_647)) {
				ui.notify("必须是 0 到 2147483647 的整数毫秒值", "error");
				continue;
			}
			store.updateProvider(providerId, (p) => { if (trimmed) p[action] = Number(trimmed); else delete p[action]; });
		} else continue;
		ui.notify("已保存供应商传输设置；请 /reload 或重启 Pi 后生效", "info");
	}
}
