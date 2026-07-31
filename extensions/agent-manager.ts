/**
 * /agents — 交互式子代理管理
 *
 * 列出 ~/.pi/agent/agents/*.md，交互编辑 model / thinkingLevel / tools /
 * description / 系统提示正文，支持新建和删除。
 * frontmatter 按行处理：只改受管字段，其余行原样保留。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");
/** 受管 frontmatter 字段（单行 key: value） */
const MANAGED_KEYS = ["name", "description", "tools", "model", "thinkingLevel"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

interface AgentFile {
	path: string;
	name: string;
	description: string;
	model: string;
	thinkingLevel: string;
	tools: string;
}

/** 解析 frontmatter 中的受管字段（只认单行 key: value） */
export function parseFields(lines: string[]): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of lines) {
		const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
		if (kv && (MANAGED_KEYS as readonly string[]).includes(kv[1])) {
			let v = kv[2].trim();
			// 去掉双引号（我们序列化时用 JSON 引号）
			if (v.startsWith('"') && v.endsWith('"')) {
				try { v = JSON.parse(v); } catch { /* 原样保留 */ }
			}
			fields[kv[1]] = v;
		}
	}
	return fields;
}

export function readAgent(path: string): AgentFile | null {
	const content = readFileSync(path, "utf8");
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return null;
	const fields = parseFields(m[1].split(/\r?\n/));
	return {
		path,
		name: fields.name ?? "",
		description: fields.description ?? "",
		model: fields.model ?? "",
		thinkingLevel: fields.thinkingLevel ?? "",
		tools: fields.tools ?? "",
	};
}

export function listAgents(): AgentFile[] {
	if (!existsSync(AGENTS_DIR)) return [];
	return readdirSync(AGENTS_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.map((f) => readAgent(join(AGENTS_DIR, f)))
		.filter((a): a is AgentFile => a !== null);
}

/** 更新或清除某个受管字段；值不存在则追加，清空则删行 */
export function setField(path: string, key: string, value: string | undefined): void {
	const content = readFileSync(path, "utf8");
	const m = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/);
	if (!m) throw new Error("frontmatter 格式无法识别");
	const lines = m[2].split(/\r?\n/);
	const serialized = value === undefined || value === "" ? undefined
		: key === "description" ? JSON.stringify(value)
		: value;
	let found = false;
	const out: string[] = [];
	for (const line of lines) {
		const kv = line.match(/^([A-Za-z]+):/);
		if (kv && kv[1] === key) {
			found = true;
			if (serialized !== undefined) out.push(`${key}: ${serialized}`);
			continue; // 清掉旧行（含被清除的情况）
		}
		out.push(line);
	}
	if (!found && serialized !== undefined) out.push(`${key}: ${serialized}`);
	writeFileSync(path, m[1] + out.join("\n") + m[3] + m[4]);
}

export function getBody(path: string): string {
	const content = readFileSync(path, "utf8");
	const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
	return m ? m[1] : content;
}

export function setBody(path: string, body: string): void {
	const content = readFileSync(path, "utf8");
	const m = content.match(/^(---\r?\n[\s\S]*?\r?\n---)\r?\n?[\s\S]*$/);
	if (!m) throw new Error("frontmatter 格式无法识别");
	writeFileSync(path, m[1] + "\n" + body);
}

/** 通用单选对话框（支持输入字符过滤，子串匹配 label/value/description） */
async function pick(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	help = "↑↓ 移动 • enter 选择 • 直接输入可搜索 • esc 返回",
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const listTheme = {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		};
		const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		const helpText = new Text(theme.fg("dim", help), 1, 0);
		const filterText = new Text("", 1, 0);
		const container = new Container();

		let filter = "";
		let list: SelectList;

		const filteredItems = () => {
			if (!filter) return items;
			const q = filter.toLowerCase();
			return items.filter((it) =>
				[it.value, it.label, it.description ?? ""].some((s) => s.toLowerCase().includes(q)),
			);
		};

		const rebuild = () => {
			const matched = filteredItems();
			list = new SelectList(matched, Math.min(Math.max(matched.length, 1), 12), listTheme);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			filterText.setText(theme.fg("dim", filter ? `搜索: ${filter} (${matched.length}/${items.length})` : ""));
			container.clear();
			container.addChild(topBorder);
			container.addChild(titleText);
			container.addChild(filterText);
			container.addChild(list);
			container.addChild(helpText);
			container.addChild(bottomBorder);
			container.invalidate();
			tui.requestRender();
		};
		rebuild();

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				// 退格删字符；可见字符（含中文）追加为过滤词；其余按键交给列表
				if (data === "\x7f" || data === "\b") {
					if (filter) { filter = filter.slice(0, -1); rebuild(); return; }
				} else if (!data.startsWith("\x1b") && /^[^\x00-\x1f\x7f]+$/.test(data)) {
					filter += data;
					rebuild();
					return;
				}

				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function agentSummary(a: AgentFile): string {
	const parts = [a.model || "默认模型", a.thinkingLevel || "默认 thinking"];
	return parts.join(" • ");
}

/** 单个 agent 的编辑菜单 */
async function editAgent(ctx: ExtensionCommandContext, agent: AgentFile): Promise<void> {
	for (;;) {
		const fresh = readAgent(agent.path) ?? agent;
		const action = await pick(ctx, `编辑 ${fresh.name}`, [
			{ value: "model", label: `模型: ${fresh.model || "(默认)"}`, description: "如 new-api/kimi-k3" },
			{ value: "thinking", label: `Thinking: ${fresh.thinkingLevel || "(默认)"}`, description: "思考档位" },
			{ value: "tools", label: `工具: ${fresh.tools || "(全部)"}`, description: "逗号分隔，留空为全部工具" },
			{ value: "description", label: "描述", description: fresh.description.slice(0, 60) || "(空)" },
			{ value: "body", label: "系统提示正文", description: "多行编辑器" },
			{ value: "delete", label: "删除此 agent", description: fresh.path },
		]);
		if (action === null) return;

		try {
			if (action === "model") {
				// 从注册表读可用模型直接选择，也可手动输入或清除
				const available = ctx.modelRegistry.getAvailable();
				const current = `${fresh.model}`;
				const v = await pick(ctx, `选择模型 (当前: ${current || "默认"})`, [
					...available.map((m) => {
						const ref = `${m.provider}/${m.id}`;
						return { value: ref, label: ref, description: m.name && m.name !== m.id ? m.name : undefined };
					}),
					{ value: "__manual__", label: "手动输入…", description: "列表里没有的模型" },
					{ value: "", label: "(清除，用默认)" },
				]);
				if (v === null) { /* 取消 */ }
				else if (v === "__manual__") {
					const manual = await ctx.ui.input("模型 (provider/id，留空清除):", fresh.model);
					if (manual !== undefined) { setField(agent.path, "model", manual.trim() || undefined); ctx.ui.notify("已保存", "info"); }
				} else {
					setField(agent.path, "model", v || undefined); ctx.ui.notify("已保存", "info");
				}
			} else if (action === "thinking") {
				const v = await pick(ctx, "Thinking 档位", [
					...THINKING_LEVELS.map((l) => ({ value: l, label: l })),
					{ value: "", label: "(清除，用默认)" },
				]);
				if (v !== null) { setField(agent.path, "thinkingLevel", v || undefined); ctx.ui.notify("已保存", "info"); }
			} else if (action === "tools") {
				const v = await ctx.ui.input("工具列表 (逗号分隔，留空清除):", fresh.tools);
				if (v !== undefined) { setField(agent.path, "tools", v.trim() || undefined); ctx.ui.notify("已保存", "info"); }
			} else if (action === "description") {
				const v = await ctx.ui.input("描述:", fresh.description);
				if (v !== undefined) { setField(agent.path, "description", v.trim() || undefined); ctx.ui.notify("已保存", "info"); }
			} else if (action === "body") {
				const v = await ctx.ui.editor("系统提示正文 (ctrl+s 之外按 esc 完成):", getBody(agent.path));
				if (v !== undefined) { setBody(agent.path, v); ctx.ui.notify("已保存", "info"); }
			} else if (action === "delete") {
				const ok = await ctx.ui.confirm("删除 agent", `确定删除 ${fresh.name} (${fresh.path})？不可恢复`);
				if (ok) { rmSync(agent.path); ctx.ui.notify(`已删除 ${fresh.name}`, "info"); return; }
			}
		} catch (e) {
			ctx.ui.notify(`保存失败: ${e instanceof Error ? e.message : e}`, "error");
		}
	}
}

/** 新建 agent */
async function createAgent(ctx: ExtensionCommandContext): Promise<void> {
	const name = await ctx.ui.input("新 agent 名称 (小写字母/数字/连字符):", "my-agent");
	if (!name) return;
	const safe = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!safe) { ctx.ui.notify("名称不合法", "error"); return; }
	const path = join(AGENTS_DIR, `${safe}.md`);
	if (existsSync(path)) { ctx.ui.notify(`${safe}.md 已存在`, "error"); return; }
	mkdirSync(AGENTS_DIR, { recursive: true });
	writeFileSync(path, `---\nname: ${safe}\ndescription: ""\n---\n\nYou are a worker agent for delegated tasks.\n`);
	ctx.ui.notify(`已创建 ${path}`, "info");
	const agent = readAgent(path);
	if (agent) await editAgent(ctx, agent);
}

// ==================== 供应商/模型管理 (models.json) ====================
 
const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");
const API_TYPES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
 
type ModelEntry = Record<string, unknown>;
interface ProviderCfg {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	models?: ModelEntry[];
	[k: string]: unknown;
}
interface ModelsJson {
	providers: Record<string, ProviderCfg>;
	[k: string]: unknown;
}
 
export function loadModelsJson(): ModelsJson {
	if (!existsSync(MODELS_JSON_PATH)) return { providers: {} };
	return JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8")) as ModelsJson;
}
 
function saveModelsJson(cfg: ModelsJson): void {
	writeFileSync(MODELS_JSON_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
 
/** 解析 apiKey 配置值：$ENV / 字面量；!command 不支持返回 undefined */
function resolveSecret(v: string | undefined): string | undefined {
	if (!v) return undefined;
	if (v.startsWith("$")) return process.env[v.slice(1).replace(/[{}]/g, "")];
	if (v.startsWith("!")) return undefined;
	return v;
}
 
/** 从 {baseUrl}/models 拉取模型 id 列表 */
async function fetchEndpointModels(baseUrl: string, apiKey?: string): Promise<string[]> {
	const url = baseUrl.replace(/\/+$/, "") + "/models";
	const res = await fetch(url, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as { data?: Array<{ id?: string }> };
	return (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x).sort();
}
 
// ---------- models.dev 元数据 ----------
 
interface ModelsDevEntry {
	name?: string;
	reasoning?: boolean;
	modalities?: { input?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; output?: number };
}
 
let modelsDevCache: Map<string, ModelsDevEntry> | null = null;
 
/** 拉取 models.dev 全量索引（内存缓存）；key 为小写 id 及去前缀形式 */
async function loadModelsDev(): Promise<Map<string, ModelsDevEntry>> {
	if (modelsDevCache) return modelsDevCache;
	const map = new Map<string, ModelsDevEntry>();
	try {
		const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as Record<string, { models?: Record<string, ModelsDevEntry> }>;
		for (const provider of Object.values(data)) {
			for (const [id, entry] of Object.entries(provider.models ?? {})) {
				const key = id.toLowerCase();
				if (!map.has(key)) map.set(key, entry);
				const short = key.split("/").pop() ?? key;
				if (!map.has(short)) map.set(short, entry);
			}

		}

	} catch {
		// 网络不可用时返回空表，后续按无元数据处理
	}

	modelsDevCache = map;
	return map;
}
 
function lookupModelsDev(index: Map<string, ModelsDevEntry>, id: string): ModelsDevEntry | undefined {
	const key = id.toLowerCase();
	return index.get(key) ?? index.get(key.split("/").pop() ?? key);
}
 
/** 按 models.dev 元数据构建模型条目 */
function buildModelEntry(id: string, meta: ModelsDevEntry | undefined): ModelEntry {
	const entry: ModelEntry = { id };
	if (!meta) return entry;
	if (meta.name) entry.name = meta.name;
	if (meta.reasoning !== undefined) entry.reasoning = meta.reasoning;
	const input = (meta.modalities?.input ?? []).filter((x) => x === "text" || x === "image");
	if (input.length > 0) entry.input = input;
	if (meta.cost) {
		entry.cost = {
			input: meta.cost.input ?? 0,
			output: meta.cost.output ?? 0,
			cacheRead: meta.cost.cache_read ?? 0,
			cacheWrite: meta.cost.cache_write ?? 0,
		};
	}

	if (meta.limit?.context) entry.contextWindow = meta.limit.context;
	if (meta.limit?.output) entry.maxTokens = meta.limit.output;
	return entry;
}
 
// ---------- 供应商操作 ----------
 
async function addModelWithMeta(
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
	index: Map<string, ModelsDevEntry>,
): Promise<void> {
	const cfg = loadModelsJson();
	const p = cfg.providers[providerId];
	p.models = p.models ?? [];
	if (p.models.some((m) => m.id === modelId)) {
		ctx.ui.notify("该模型已存在", "warning");
		return;
	}

	const meta = lookupModelsDev(index, modelId);
	p.models.push(buildModelEntry(modelId, meta));
	saveModelsJson(cfg);
	ctx.ui.notify(
		meta ? `已添加 ${modelId}（已按 models.dev 填充参数）` : `已添加 ${modelId}（models.dev 无数据，仅写入 id）`,
		"info",
	);
}
 
async function addModelManual(ctx: ExtensionCommandContext, providerId: string): Promise<void> {
	const v = await ctx.ui.input("模型 id:", "");
	if (!v?.trim()) return;
	await addModelWithMeta(ctx, providerId, v.trim(), await loadModelsDev());
}
 
async function addModelsFromEndpoint(ctx: ExtensionCommandContext, providerId: string): Promise<void> {
	const p = loadModelsJson().providers[providerId];
	if (!p?.baseUrl) {
		ctx.ui.notify("该供应商未配置 baseUrl，请手动输入", "warning");
		return;
	}

	let ids: string[];
	try {
		ctx.ui.notify("正在拉取模型列表…", "info");
		ids = await fetchEndpointModels(p.baseUrl, resolveSecret(p.apiKey));
	} catch (e) {
		ctx.ui.notify(`拉取失败: ${e instanceof Error ? e.message : e}，请改用手动输入`, "error");
		return;
	}

	if (ids.length === 0) {
		ctx.ui.notify("接口未返回任何模型", "warning");
		return;
	}

	const index = await loadModelsDev();
	// 循环添加，esc 结束；已存在的打勾标记
	for (;;) {
		const existing = new Set((loadModelsJson().providers[providerId].models ?? []).map((m) => String(m.id)));
		const items: SelectItem[] = ids.map((id) => ({
			value: id,
			label: existing.has(id) ? `${id} ✓` : id,
			description: existing.has(id) ? "已存在" : (lookupModelsDev(index, id)?.name ?? undefined),
		}));
		const chosen = await pick(ctx, `添加模型到 ${providerId} (esc 结束)`, items);
		if (chosen === null) return;
		await addModelWithMeta(ctx, providerId, chosen, index);
	}
}
 
async function removeModel(ctx: ExtensionCommandContext, providerId: string): Promise<void> {
	const models = loadModelsJson().providers[providerId].models ?? [];
	if (models.length === 0) {
		ctx.ui.notify("没有模型可删", "warning");
		return;
	}

	const chosen = await pick(
		ctx,
		"删除模型",
		models.map((m) => ({
			value: String(m.id),
			label: String(m.id),
			description: typeof m.name === "string" ? m.name : undefined,
		})),
	);
	if (chosen === null) return;
	const ok = await ctx.ui.confirm("删除模型", `从 ${providerId} 删除 ${chosen}？`);
	if (!ok) return;
	const cfg = loadModelsJson();
	const p = cfg.providers[providerId];
	p.models = (p.models ?? []).filter((m) => m.id !== chosen);
	saveModelsJson(cfg);
	ctx.ui.notify("已删除", "info");
}
 
async function createProvider(ctx: ExtensionCommandContext): Promise<void> {
	const id = await ctx.ui.input("供应商 id (如 my-proxy):", "");
	if (!id?.trim()) return;
	const pid = id.trim();
	if (loadModelsJson().providers[pid]) {
		ctx.ui.notify("供应商已存在", "error");
		return;
	}

	const baseUrl = await ctx.ui.input("baseUrl (如 http://host:3000/v1):", "");
	if (!baseUrl?.trim()) return;
	const api = await pick(ctx, "API 类型", API_TYPES.map((t) => ({ value: t, label: t })));
	if (api === null) return;
	const apiKey = await ctx.ui.input("apiKey (支持 $ENV_VAR，可留空):", "");

	const cfg = loadModelsJson();
	cfg.providers[pid] = {
		baseUrl: baseUrl.trim(),
		api,
		...(apiKey?.trim() ? { apiKey: apiKey.trim(), authHeader: true } : {}),
		models: [],
	};
	saveModelsJson(cfg);
	ctx.ui.notify(`已创建供应商 ${pid}，接着添加模型`, "info");
	await addModelsFromEndpoint(ctx, pid);
}
 
/** 编辑单个模型条目（模型级覆盖） */
async function editModelEntry(ctx: ExtensionCommandContext, providerId: string): Promise<void> {
	const models = loadModelsJson().providers[providerId].models ?? [];
	if (models.length === 0) {
		ctx.ui.notify("没有模型可编辑", "warning");
		return;
	}

	const modelId = await pick(
		ctx,
		"选择要编辑的模型",
		models.map((m) => ({
			value: String(m.id),
			label: String(m.id),
			description: [m.api, typeof m.name === "string" ? m.name : ""].filter(Boolean).join(" • ") || undefined,
		})),
	);
	if (modelId === null) return;

	// 每次操作都重读文件，避免覆盖并发修改
	const getEntry = (): ModelEntry | undefined =>
		(loadModelsJson().providers[providerId].models ?? []).find((m) => m.id === modelId);
	const saveEntry = (updater: (entry: ModelEntry) => void): boolean => {
		const cfg = loadModelsJson();
		const entry = (cfg.providers[providerId].models ?? []).find((m) => m.id === modelId);
		if (!entry) return false;
		updater(entry);
		saveModelsJson(cfg);
		return true;
	};

	for (;;) {
		const m = getEntry();
		if (!m) {
			ctx.ui.notify("模型已不存在", "warning");
			return;
		}

		const headerCount = m.headers && typeof m.headers === "object" ? Object.keys(m.headers).length : 0;
		const thinkingSummary = summarizeThinkingLevelMap(m);
		const supportsReasoningEffort = getCompat(m).supportsReasoningEffort;
		const action = await pick(ctx, `编辑 ${modelId}`, [
			{ value: "api", label: `api: ${typeof m.api === "string" ? m.api : "(供应商默认)"}`, description: "模型级接口类型，如 openai-responses" },
			{ value: "headers", label: `headers 客户端指纹 (${headerCount} 个)`, description: "如 User-Agent / x-grok-* 等自定义请求头" },
			{ value: "name", label: `name: ${typeof m.name === "string" ? m.name : "(同 id)"}`, description: "显示名称" },
			{ value: "reasoning", label: `reasoning: ${m.reasoning === undefined ? "(默认 false)" : String(m.reasoning)}`, description: "是否支持思考" },
			{ value: "thinkingLevelMap", label: `thinkingLevelMap: ${thinkingSummary}`, description: "配置每个 pi 档位及其上游映射" },
			{ value: "supportsReasoningEffort", label: `reasoning_effort: ${supportsReasoningEffort === undefined ? "(自动检测)" : String(supportsReasoningEffort)}`, description: "OpenAI 兼容接口是否发送思考强度参数" },
			{ value: "input", label: `input: ${Array.isArray(m.input) ? m.input.join("+") : "(默认 text)"}`, description: "输入模态" },
			{ value: "contextWindow", label: `contextWindow: ${m.contextWindow ?? "(默认 128000)"}`, description: "上下文窗口" },
			{ value: "maxTokens", label: `maxTokens: ${m.maxTokens ?? "(默认 16384)"}`, description: "最大输出 tokens" },
			{ value: "baseUrl", label: `baseUrl: ${typeof m.baseUrl === "string" ? m.baseUrl : "(供应商默认)"}`, description: "模型级端点覆盖（如 anthropic 模型去 /v1）" },
		]);
		if (action === null) return;

		try {
			if (action === "api") {
				const v = await pick(ctx, "模型级 api", [
					...API_TYPES.map((t) => ({ value: t, label: t })),
					{ value: "", label: "(清除，用供应商默认)" },
				]);
				if (v !== null) {
					saveEntry((e) => { v ? (e.api = v) : delete e.api; });
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "headers") {
				await editModelHeaders(ctx, modelId, getEntry, saveEntry);

			} else if (action === "name") {
				const v = await ctx.ui.input("显示名称 (留空清除):", typeof m.name === "string" ? m.name : "");
				if (v !== undefined) {
					saveEntry((e) => { v.trim() ? (e.name = v.trim()) : delete e.name; });
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "reasoning") {
				const v = await pick(ctx, "reasoning", [
					{ value: "true", label: "true" },
					{ value: "false", label: "false" },
					{ value: "", label: "(清除，默认 false)" },
				]);
				if (v !== null) {
					saveEntry((e) => { v === "" ? delete e.reasoning : (e.reasoning = v === "true"); });
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "thinkingLevelMap") {
				await editThinkingLevelMap(ctx, modelId, getEntry, saveEntry);

			} else if (action === "supportsReasoningEffort") {
				const current = getCompat(m).supportsReasoningEffort;
				const v = await pick(ctx, "发送 reasoning_effort", [
					{ value: "true", label: "true", description: "发送映射后的思考强度" },
					{ value: "false", label: "false", description: "不发送 reasoning_effort" },
					{ value: "", label: "(自动检测)", description: `当前: ${current === undefined ? "自动检测" : String(current)}` },
				]);
				if (v !== null) {
					saveEntry((e) => {
						const compat = { ...getCompat(e) };
						if (v === "") delete compat.supportsReasoningEffort;
						else compat.supportsReasoningEffort = v === "true";
						if (Object.keys(compat).length > 0) e.compat = compat;
						else delete e.compat;
					});
					ctx.ui.notify("已保存", "info");
				}
			} else if (action === "input") {
				const v = await pick(ctx, "输入模态", [
					{ value: "text", label: "text" },
					{ value: "text,image", label: "text + image" },
					{ value: "", label: "(清除，默认 text)" },
				]);
				if (v !== null) {
					saveEntry((e) => { v ? (e.input = v.split(",")) : delete e.input; });
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "contextWindow" || action === "maxTokens") {
				const cur = action === "contextWindow" ? m.contextWindow : m.maxTokens;
				const v = await ctx.ui.input(`${action} (数字，留空清除):`, cur === undefined ? "" : String(cur));
				if (v !== undefined) {
					const n = Number(v.trim());
					if (v.trim() && (!Number.isFinite(n) || n <= 0)) {
						ctx.ui.notify("必须是正整数", "error");
						continue;
					}

					saveEntry((e) => { v.trim() ? (e[action] = Math.round(n)) : delete e[action]; });
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "baseUrl") {
				const v = await ctx.ui.input("模型级 baseUrl (留空清除):", typeof m.baseUrl === "string" ? m.baseUrl : "");
				if (v !== undefined) {
					saveEntry((e) => { v.trim() ? (e.baseUrl = v.trim()) : delete e.baseUrl; });
					ctx.ui.notify("已保存", "info");
				}

			}

		} catch (e) {
			ctx.ui.notify(`保存失败: ${e instanceof Error ? e.message : e}`, "error");
		}

	}
}

function getThinkingLevelMap(entry: ModelEntry): ThinkingLevelMap {
	const raw = entry.thinkingLevelMap;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const source = raw as Record<string, unknown>;
	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		if (!Object.prototype.hasOwnProperty.call(source, level)) continue;
		const value = source[level];
		if (typeof value === "string" || value === null) map[level] = value;
	}
	return map;
}

function getCompat(entry: ModelEntry): Record<string, unknown> {
	return entry.compat && typeof entry.compat === "object" && !Array.isArray(entry.compat)
		? entry.compat as Record<string, unknown>
		: {};
}

function summarizeThinkingLevelMap(entry: ModelEntry): string {
	const map = getThinkingLevelMap(entry);
	const configured = THINKING_LEVELS
		.filter((level) => Object.prototype.hasOwnProperty.call(map, level))
		.map((level) => `${level}${map[level] === null ? "×" : `→${map[level]}`}`);
	return configured.length > 0 ? configured.join(", ") : "默认 off-high";
}

async function editThinkingLevelMap(
	ctx: ExtensionCommandContext,
	modelId: string,
	getEntry: () => ModelEntry | undefined,
	saveEntry: (updater: (entry: ModelEntry) => void) => boolean,
): Promise<void> {
	for (;;) {
		const entry = getEntry();
		if (!entry) return;
		const map = getThinkingLevelMap(entry);
		const action = await pick(ctx, `${modelId} 思考档位映射`, [
			...THINKING_LEVELS.map((level) => {
				const configured = Object.prototype.hasOwnProperty.call(map, level);
				const value = map[level];
				const state = !configured
					? "(继承 pi 默认)"
					: value === null
						? "(不支持)"
						: value === level
							? `${value} (透传)`
							: `→ ${value}`;
				return {
					value: level,
					label: `${level}: ${state}`,
					description: level === "xhigh" || level === "max"
						? "扩展档位必须显式配置为非 null 才会显示"
						: "缺省时使用 pi 标准映射",
				};
			}),
			{ value: "__clear__", label: "清空全部映射", description: "恢复 pi 默认：off 到 high" },
		]);
		if (action === null) return;

		if (action === "__clear__") {
			if (await ctx.ui.confirm("清空思考映射", `删除 ${modelId} 的 thinkingLevelMap？`)) {
				saveEntry((e) => { delete e.thinkingLevelMap; });
				ctx.ui.notify("已恢复 pi 默认映射", "info");
			}
			continue;
		}

		const level = action as ThinkingLevel;
		const current = map[level];
		const operation = await pick(ctx, `${level} 档位`, [
			{ value: "passthrough", label: "透传同名值", description: `${level} → ${level}` },
			{ value: "custom", label: "映射到自定义值", description: typeof current === "string" ? `当前: ${current}` : "如 max / high / low" },
			{ value: "unsupported", label: "标记为不支持", description: "写入 null，并从切换列表隐藏" },
			{ value: "inherit", label: "继承 pi 默认", description: "删除该档位字段" },
		]);
		if (operation === null) continue;

		let value: string | null | undefined;
		if (operation === "custom") {
			const input = await ctx.ui.input("上游思考强度值:", typeof current === "string" ? current : level);
			if (input === undefined) continue;
			if (!input.trim()) {
				ctx.ui.notify("映射值不能为空；需要隐藏该档位请选择“不支持”", "error");
				continue;
			}
			value = input.trim();
		} else if (operation === "passthrough") value = level;
		else if (operation === "unsupported") value = null;

		saveEntry((e) => {
			const next = getThinkingLevelMap(e);
			if (operation === "inherit") delete next[level];
			else next[level] = value ?? null;
			if (Object.keys(next).length > 0) e.thinkingLevelMap = next;
			else delete e.thinkingLevelMap;
		});
		ctx.ui.notify(`${level} 映射已保存`, "info");
	}
}

/** 编辑模型的 headers（客户端指纹） */
async function editModelHeaders(
	ctx: ExtensionCommandContext,
	modelId: string,
	getEntry: () => ModelEntry | undefined,
	saveEntry: (updater: (entry: ModelEntry) => void) => boolean,
): Promise<void> {
	for (;;) {
		const m = getEntry();
		if (!m) return;
		const headers = (m.headers && typeof m.headers === "object" ? m.headers : {}) as Record<string, string>;
		const keys = Object.keys(headers).sort();

		const action = await pick(ctx, `${modelId} headers (${keys.length} 个)`, [
			...keys.map((k) => ({ value: k, label: k, description: headers[k] })),
			{ value: "__add__", label: "＋ 新增/覆盖 header", description: "格式 Key: Value" },
			{ value: "__clear__", label: "清空全部 headers", description: "删除整个 headers 字段" },
		]);
		if (action === null) return;

		if (action === "__add__") {
			const v = await ctx.ui.input("Header (格式 Key: Value):", "User-Agent: my-client/1.0");
			if (v === undefined) continue;
			const idx = v.indexOf(":");
			const k = idx > 0 ? v.slice(0, idx).trim() : "";
			const val = idx > 0 ? v.slice(idx + 1).trim() : "";
			if (!k || !val) {
				ctx.ui.notify("格式不对，应为 Key: Value", "error");
				continue;
			}

			saveEntry((e) => {
				const h = (e.headers && typeof e.headers === "object" ? e.headers : {}) as Record<string, string>;
				e.headers = { ...h, [k]: val };
			});
			ctx.ui.notify("已保存", "info");

		} else if (action === "__clear__") {
			const ok = await ctx.ui.confirm("清空 headers", `删除 ${modelId} 的全部自定义请求头？`);
			if (ok) {
				saveEntry((e) => { delete e.headers; });
				ctx.ui.notify("已清空", "info");
			}

		} else {
			// 选中已有 header：编辑或删除
			const op = await pick(ctx, `header ${action}`, [
				{ value: "edit", label: "修改值", description: headers[action] },
				{ value: "del", label: "删除此 header", description: action },
			]);
			if (op === "edit") {
				const v = await ctx.ui.input(`${action} 的新值:`, headers[action]);
				if (v !== undefined && v.trim()) {
					saveEntry((e) => {
						const h = (e.headers && typeof e.headers === "object" ? e.headers : {}) as Record<string, string>;
						e.headers = { ...h, [action]: v.trim() };
					});
					ctx.ui.notify("已保存", "info");
				}

			} else if (op === "del") {
				saveEntry((e) => {
					const h = { ...((e.headers ?? {}) as Record<string, string>) };
					delete h[action];
					if (Object.keys(h).length > 0) e.headers = h;
					else delete e.headers;
				});
				ctx.ui.notify("已删除", "info");
			}

		}

	}
}
 
async function manageProvider(ctx: ExtensionCommandContext, providerId: string): Promise<void> {
	for (;;) {
		const p = loadModelsJson().providers[providerId];
		if (!p) {
			ctx.ui.notify("供应商已不存在", "warning");
			return;
		}

		const action = await pick(ctx, `供应商 ${providerId}`, [
			{
				value: "add",
				label: `添加模型 (接口拉取, 当前 ${p.models?.length ?? 0} 个)`,
				description: `${(p.baseUrl ?? "").replace(/\/+$/, "")}/models`,
			},
			{ value: "add-manual", label: "添加模型 (手动输入)", description: "接口不可用时使用" },
			{ value: "edit", label: "编辑模型", description: "模型级 api / headers 客户端指纹 / 参数覆盖" },
			{ value: "remove", label: "删除模型", description: "从列表选择" },
			{ value: "baseUrl", label: `baseUrl: ${p.baseUrl ?? "(无)"}`, description: "编辑" },
			{ value: "apiKey", label: `apiKey: ${p.apiKey ? "已配置" : "(未配置)"}`, description: "支持 $ENV_VAR 引用" },
			{ value: "api", label: `API 类型: ${p.api ?? "(无)"}`, description: "修改 API 类型" },
			{ value: "delete", label: "删除此供应商", description: "含全部模型定义" },
		]);
		if (action === null) return;

		try {
			if (action === "add") await addModelsFromEndpoint(ctx, providerId);
			else if (action === "add-manual") await addModelManual(ctx, providerId);
			else if (action === "edit") await editModelEntry(ctx, providerId);
			else if (action === "remove") await removeModel(ctx, providerId);
			else if (action === "baseUrl") {
				const v = await ctx.ui.input("baseUrl:", p.baseUrl ?? "");
				if (v?.trim()) {
					const cfg = loadModelsJson();
					cfg.providers[providerId].baseUrl = v.trim();
					saveModelsJson(cfg);
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "apiKey") {
				const v = await ctx.ui.input("apiKey (留空清除):", p.apiKey ?? "");
				if (v !== undefined) {
					const cfg = loadModelsJson();
					const target = cfg.providers[providerId];
					if (v.trim()) target.apiKey = v.trim();
					else delete target.apiKey;
					saveModelsJson(cfg);
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "api") {
				const v = await pick(ctx, "API 类型", API_TYPES.map((t) => ({ value: t, label: t })));
				if (v !== null) {
					const cfg = loadModelsJson();
					cfg.providers[providerId].api = v;
					saveModelsJson(cfg);
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "delete") {
				const ok = await ctx.ui.confirm("删除供应商", `确定删除 ${providerId} 及其 ${p.models?.length ?? 0} 个模型定义？`);
				if (ok) {
					const cfg = loadModelsJson();
					delete cfg.providers[providerId];
					saveModelsJson(cfg);
					ctx.ui.notify("已删除", "info");
					return;
				}

			}

		} catch (e) {
			ctx.ui.notify(`操作失败: ${e instanceof Error ? e.message : e}`, "error");
		}

	}
}
 
export default function agentManager(pi: ExtensionAPI) {
	pi.registerCommand("agents", {
		description: "交互式管理子代理 (~/.pi/agent/agents/*.md)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/agents 仅在 TUI 模式可用", "warning");
				return;
			}
			for (;;) {
				const agents = listAgents();
				const items: SelectItem[] = [
					...agents.map((a) => ({
						value: a.path,
						label: a.name || a.path,
						description: agentSummary(a),
					})),
					{ value: "__new__", label: "＋ 新建 agent", description: AGENTS_DIR },
				];
				const chosen = await pick(ctx, `子代理管理 (${agents.length} 个)`, items);
				if (chosen === null) return;
				if (chosen === "__new__") await createAgent(ctx);
				else {
					const agent = readAgent(chosen);
					if (agent) await editAgent(ctx, agent);
					else ctx.ui.notify("无法解析该文件", "error");
				}
			}
		},
	});

	pi.registerCommand("providers", {
		description: "交互式管理供应商和模型 (~/.pi/agent/models.json)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/providers 仅在 TUI 模式可用", "warning");
				return;
			}

			for (;;) {
				const cfg = loadModelsJson();
				const ids = Object.keys(cfg.providers).sort();
				const items: SelectItem[] = [
					...ids.map((id) => {
						const p = cfg.providers[id];
						return {
							value: id,
							label: id,
							description: `${p.baseUrl ?? "(无 baseUrl)"} • ${p.models?.length ?? 0} 个模型`,
						};
					}),
					{ value: "__new__", label: "＋ 新增供应商", description: MODELS_JSON_PATH },
				];
				const chosen = await pick(ctx, `供应商管理 (${ids.length} 个)`, items);
				if (chosen === null) return;
				if (chosen === "__new__") await createProvider(ctx);
				else await manageProvider(ctx, chosen);
			}

		}

	});
}
