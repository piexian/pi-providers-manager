import { TRANSPORTS, TransportConfigStore, type Transport } from "./transport-config.ts";

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
	const unsupported = [...new Set(apis.filter((api) => api !== "openai-responses" && api !== "openai-codex-responses"))];
	for (;;) {
		const settings = store.readProvider(providerId);
		const action = await ui.pick(`${providerId} 传输设置（保存后 /reload 生效）`, [
			{ value: "transport", label: `transport: ${settings.transport ?? "(继承 Pi，不接管传输)"}`, description: unsupported.length ? `这些 API 没有 WS 适配，严格 WS 会报错: ${unsupported.join(", ")}` : "适用于该供应商的全部模型；不改变 API 类型和凭据" },
			{ value: "websocketConnectTimeoutMs", label: `WS 握手超时: ${settings.websocketConnectTimeoutMs ?? "(继承 Pi，默认 15000)"} ms`, description: "0 禁用；留空清除供应商覆盖" },
			{ value: "httpIdleTimeoutMs", label: `流空闲超时: ${settings.httpIdleTimeoutMs ?? "(继承 Pi，默认 300000)"} ms`, description: "WS/HTTP 等待流事件的最大空闲间隔；0 禁用" },
		]);
		if (action === null) return;
		if (action === "transport") {
			const mode = await ui.pick("传输方式", [
				{ value: "", label: "继承 Pi（不接管传输）", description: "删除该供应商的 transport 覆盖；普通 Responses 在 Pi 0.85.1 中仍为 SSE" },
				...TRANSPORTS.map((value) => ({ value, label: value, description: DESCRIPTIONS[value] })),
			]);
			if (mode === null) continue;
			if (mode !== "" && !(TRANSPORTS as readonly string[]).includes(mode)) continue;
			if (mode && (new Set(apis).size !== 1 || ((mode === "websocket" || mode === "websocket-cached") && unsupported.length))) {
				ui.notify("当前 API 组合无法应用此传输方式；混合 API 请拆分供应商，不支持 WS 的 API 请用 SSE", "error");
				continue;
			}
			store.updateProvider(providerId, (p) => { if (mode) p.transport = mode as Transport; else delete p.transport; });
		} else if (action === "websocketConnectTimeoutMs" || action === "httpIdleTimeoutMs") {
			const current = settings[action];
			const value = await ui.input(`${action}（整数毫秒；0 禁用；留空继承 Pi）:`, current === undefined ? "" : String(current));
			if (value === undefined) continue;
			const trimmed = value.trim();
			if (trimmed && (!/^\d+$/.test(trimmed) || Number(trimmed) > 2_147_483_647)) {
				ui.notify("必须是 0 到 2147483647 的整数毫秒值", "error");
				continue;
			}
			store.updateProvider(providerId, (p) => { if (trimmed) p[action] = Number(trimmed); else delete p[action]; });
		} else continue;
		ui.notify("已保存供应商传输设置；请 /reload 或重启 Pi 后生效", "info");
	}
}
