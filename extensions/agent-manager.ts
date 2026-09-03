/**
 * /providers — 交互式供应商/模型管理(models.json)
 * /agents — 交互式子代理管理(agents/*.md)
 *
 * /providers 覆盖:供应商 CRUD、provider 级 compat/headers/authHeader/name、
 * modelOverrides(最终覆盖层)、模型 CRUD 与模型级 api/compat/headers/参数编辑。
 * models.json 按 JSONC 读写,注释与 BOM 均保留。
 *
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
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";

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
 
/** JSONC 解析：保留注释（以 symbol 属性挂载），stringify 时原样回写 */
export function loadModelsJson(): ModelsJson {
	if (!existsSync(MODELS_JSON_PATH)) return { providers: {} };
	const raw = readFileSync(MODELS_JSON_PATH, "utf8").replace(/^\uFEFF/, "");
	return parseJsonc(raw) as unknown as ModelsJson;
}
 
function saveModelsJson(cfg: ModelsJson): void {
	writeFileSync(MODELS_JSON_PATH, stringifyJsonc(cfg, null, 2) + "\n");
}
 
/** 解析 apiKey 配置值：$ENV / 字面量；!command 不支持返回 undefined */
function resolveSecret(v: string | undefined): string | undefined {
	if (!v) return undefined;
	if (v.startsWith("$")) return process.env[v.slice(1).replace(/[{}]/g, "")];
	if (v.startsWith("!")) return undefined;
	return v;
}
 
/** 拉取模型列表的鉴权头：按 API 类型选择网关习惯的凭证头 */
function buildModelsListHeaders(api: string | undefined, apiKey?: string): Record<string, string> {
	if (!apiKey) return {};
	if (api === "anthropic-messages") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
	if (api === "google-generative-ai") return { "x-goog-api-key": apiKey };
	return { Authorization: `Bearer ${apiKey}` };
}
 
/** anthropic / gemini SDK 会在 baseUrl 后自拼版本化路径（/v1/messages、/v1beta/...），结尾版本段必须剥掉；openai 系则要求保留 */
const VERSION_SUFFIX_RE = /\/v\d+[a-z]*\/?$/i;
function stripVersionSuffix(api: string | undefined, baseUrl: string): { url: string; stripped: boolean } {
	if (api !== "anthropic-messages" && api !== "google-generative-ai") return { url: baseUrl, stripped: false };
	const stripped = VERSION_SUFFIX_RE.test(baseUrl);
	return { url: baseUrl.replace(VERSION_SUFFIX_RE, ""), stripped };
}
 
/** 从 {baseUrl}/models 拉取模型 id 列表 */
async function fetchEndpointModels(baseUrl: string, headers: Record<string, string> = {}): Promise<string[]> {
	const url = baseUrl.replace(/\/+$/, "") + "/models";
	const res = await fetch(url, {
		headers,
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
	reasoning_options?: Array<{ type?: string; values?: string[] }>;
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
		// 失败不缓存，下次操作重试；本次按无元数据处理
		return map;
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

	// pi 默认隐藏 xhigh/max 两档；models.dev 标注上游支持时显式透传声明，让档位出现
	const efforts = meta.reasoning_options?.find((o) => o?.type === "effort")?.values ?? [];
	const extended: ThinkingLevelMap = {};
	if (efforts.includes("xhigh")) extended.xhigh = "xhigh";
	if (efforts.includes("max")) extended.max = "max";
	if (Object.keys(extended).length > 0) entry.thinkingLevelMap = extended;
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

	if (p.apiKey?.trim().startsWith("!")) {
		ctx.ui.notify("!command 形式的 apiKey 无法用于拉取，请改用手动输入", "warning");
		return;
	}

	let ids: string[];
	try {
		ctx.ui.notify("正在拉取模型列表…", "info");
		ids = await fetchEndpointModels(p.baseUrl, buildModelsListHeaders(p.api, resolveSecret(p.apiKey)));
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

	const api = await pick(ctx, "API 类型", API_TYPES.map((t) => ({ value: t, label: t })));
	if (api === null) return;
	const rawBase = await ctx.ui.input("baseUrl (openai 系含 /v1；anthropic/gemini 自动去版本段):", "");
	if (!rawBase?.trim()) return;
	const { url, stripped } = stripVersionSuffix(api, rawBase.trim());
	const apiKey = await ctx.ui.input("apiKey (支持 $ENV_VAR，可留空):", "");

	const cfg = loadModelsJson();
	cfg.providers[pid] = {
		baseUrl: url,
		api,
		...(apiKey?.trim() ? { apiKey: apiKey.trim(), authHeader: true } : {}),
		models: [],
	};
	saveModelsJson(cfg);
	ctx.ui.notify(stripped ? `已创建供应商 ${pid}（baseUrl 自动去除结尾版本段 → ${url}）` : `已创建供应商 ${pid}，接着添加模型`, "info");
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
		const compatCount = Object.keys(getCompat(m)).length;
		const action = await pick(ctx, `编辑 ${modelId}`, [
			{ value: "api", label: `api: ${typeof m.api === "string" ? m.api : "(供应商默认)"}`, description: "模型级接口类型，如 openai-responses" },
			{ value: "compat", label: `compat: ${compatCount} 键`, description: "缓存/思考协议兼容开关（模型级覆盖 provider 级）" },
			{ value: "headers", label: `headers 客户端指纹 (${headerCount} 个)`, description: "如 User-Agent / x-grok-* 等自定义请求头" },
			{ value: "name", label: `name: ${typeof m.name === "string" ? m.name : "(同 id)"}`, description: "显示名称" },
			{ value: "reasoning", label: `reasoning: ${m.reasoning === undefined ? "(默认 false)" : String(m.reasoning)}`, description: "是否支持思考" },
			{ value: "thinkingLevelMap", label: `thinkingLevelMap: ${thinkingSummary}`, description: "配置每个 pi 档位及其上游映射" },
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
				await editHeadersRecord(ctx, modelId, modelHeadersAcc(getEntry, saveEntry));

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

			} else if (action === "compat") {
				await editCompatRecord(
					ctx,
					`${modelId} 模型级`,
					() => {
						const fresh = getEntry();
						const pcfg = loadModelsJson().providers[providerId];
						return {
							compat: fresh ? getCompat(fresh) : {},
							providerCompat: (pcfg.compat && typeof pcfg.compat === "object" ? { ...(pcfg.compat as Record<string, unknown>) } : undefined),
							api: (typeof fresh?.api === "string" ? fresh.api : undefined) ?? (typeof pcfg.api === "string" ? pcfg.api : undefined),
						};
					},
					(next) => saveEntry((e) => { next ? (e.compat = next) : delete e.compat; }),
				);
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

/** headers（客户端指纹 / 供应商级请求头）编辑 */
/** 读取对象上的 headers 为纯净字符串 Record（拷贝，避免误持引用） */
function headersOf(obj: unknown): Record<string, string> {
	const h = (obj as { headers?: unknown } | undefined)?.headers;
	return h && typeof h === "object" && !Array.isArray(h) ? { ...(h as Record<string, string>) } : {};
}

interface HeadersAccessors {
	read: () => Record<string, string>;
	save: (next: Record<string, string> | undefined) => void;
}

/** 通用 headers 编辑器（模型级 / 供应商级 / override 共用） */
async function editHeadersRecord(
	ctx: ExtensionCommandContext,
	title: string,
	acc: HeadersAccessors,
): Promise<void> {
	for (;;) {
		const headers = acc.read();
		const keys = Object.keys(headers).sort();

		const action = await pick(ctx, `${title} headers (${keys.length} 个)`, [
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

			acc.save({ ...headers, [k]: val });
			ctx.ui.notify("已保存", "info");

		} else if (action === "__clear__") {
			const ok = await ctx.ui.confirm("清空 headers", `删除 ${title} 的全部自定义请求头？`);
			if (ok) {
				acc.save(undefined);
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
					acc.save({ ...headers, [action]: v.trim() });
					ctx.ui.notify("已保存", "info");
				}

			} else if (op === "del") {
				const h = { ...headers };
				delete h[action];
				acc.save(Object.keys(h).length > 0 ? h : undefined);
				ctx.ui.notify("已删除", "info");
			}
		}

	}
}

/** 模型级 headers 存取 */
function modelHeadersAcc(
	getEntry: () => ModelEntry | undefined,
	saveEntry: (updater: (entry: ModelEntry) => void) => boolean,
): HeadersAccessors {
	return {
		read: () => headersOf(getEntry()),
		save: (next) => saveEntry((e) => { next ? (e.headers = next) : delete e.headers; }),
	};
}
 
// ---------- compat 编辑 ----------

interface CompatKeyDef {
	key: string;
	values?: readonly string[];
	description: string;
}

const OPENAI_COMPLETIONS_COMPAT: CompatKeyDef[] = [
	{ key: "sendSessionAffinityHeaders", description: "发送会话粘性头（session_id 等），代理/LB 粘同后端提高缓存命中" },
	{ key: "supportsLongCacheRetention", description: "允许发送 prompt_cache_retention 长缓存参数；上游 400 时关掉" },
	{ key: "supportsStore", description: "发送 store:false" },
	{ key: "supportsDeveloperRole", description: "系统提示用 developer 角色而非 system" },
	{ key: "supportsReasoningEffort", description: "发送 reasoning_effort 思考强度" },
	{ key: "supportsUsageInStreaming", description: "流式带 stream_options.include_usage" },
	{ key: "supportsFinishReason", description: "要求上游必须返回 finish_reason" },
	{ key: "supportsStrictMode", description: "工具 JSON Schema strict 模式" },
	{ key: "supportsOpenAIGrammarTools", description: "自定义 grammar 工具输入" },
	{ key: "requiresReasoningContentOnAssistantMessages", description: "助手消息补 reasoning_content（DeepSeek 系需要）" },
	{ key: "requiresThinkingAsText", description: "思考内容以纯文本回放" },
	{ key: "requiresAssistantAfterToolResult", description: "tool 结果后补空 assistant 消息" },
	{ key: "requiresToolResultName", description: "tool 消息携带 name 字段" },
	{ key: "maxTokensField", values: ["max_tokens", "max_completion_tokens"], description: "最大输出的参数字段名" },
	{ key: "thinkingFormat", values: ["openai", "openrouter", "together", "baseten", "deepseek", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"], description: "思考参数协议格式" },
	{ key: "cacheControlFormat", values: ["anthropic"], description: "以 anthropic cache_control 标注缓存断点" },
	{ key: "deferredToolsMode", values: ["kimi"], description: "kimi 延迟工具模式" },
	{ key: "sessionAffinityFormat", values: ["openai", "openai-nosession", "openrouter"], description: "会话粘性头格式" },
];

const OPENAI_RESPONSES_COMPAT: CompatKeyDef[] = [
	{ key: "supportsLongCacheRetention", description: "允许长缓存保留参数；上游 400 时关掉" },
	{ key: "supportsDeveloperRole", description: "系统提示用 developer 角色" },
	{ key: "supportsStrictMode", description: "工具 JSON Schema strict 模式" },
	{ key: "supportsOpenAIGrammarTools", description: "自定义 grammar 工具输入" },
	{ key: "supportsAdditionalTools", description: "内置工具支持" },
	{ key: "supportsToolSearch", description: "工具搜索支持" },
	{ key: "sessionAffinityFormat", values: ["openai", "openai-nosession", "openrouter"], description: "会话粘性头格式" },
];

const ANTHROPIC_COMPAT: CompatKeyDef[] = [
	{ key: "sendSessionAffinityHeaders", description: "发送会话粘性头" },
	{ key: "supportsLongCacheRetention", description: "允许 cache_control 1h TTL" },
	{ key: "supportsEagerToolInputStreaming", description: "工具输入尽早流式" },
	{ key: "supportsCacheControlOnTools", description: "工具上允许 cache_control" },
	{ key: "supportsTemperature", description: "允许发送 temperature" },
	{ key: "forceAdaptiveThinking", description: "强制自适应思考" },
	{ key: "allowEmptySignature", description: "允许空思考签名（兼容代理）" },
	{ key: "supportsStrictTools", description: "工具 strict 模式" },
	{ key: "supportsToolReferences", description: "工具引用支持" },
];

function compatKeysForApi(api: string | undefined): CompatKeyDef[] {
	if (api === "openai-responses") return OPENAI_RESPONSES_COMPAT;
	if (api === "anthropic-messages") return ANTHROPIC_COMPAT;
	return OPENAI_COMPLETIONS_COMPAT;
}

interface CompatScope {
	compat: Record<string, unknown>;
	/** 上一层（provider 级）已设值，仅用于展示参照 */
	providerCompat?: Record<string, unknown>;
	api: string | undefined;
}

/**
 * 交互编辑一份 compat 对象。布尔键三态（true/false/清除=自动检测），
 * 枚举键单选；providerCompat 仅作展示参照。
 */
async function editCompatRecord(
	ctx: ExtensionCommandContext,
	title: string,
	read: () => CompatScope,
	save: (next: Record<string, unknown> | undefined) => void,
): Promise<void> {
	for (;;) {
		const { compat, providerCompat, api } = read();
		const defs = compatKeysForApi(api);

		const items: SelectItem[] = defs.map((def) => {
			const has = Object.prototype.hasOwnProperty.call(compat, def.key);
			const upstream = providerCompat && Object.prototype.hasOwnProperty.call(providerCompat, def.key)
				? String((providerCompat as Record<string, unknown>)[def.key])
				: undefined;
			const state = has
				? String(compat[def.key])
				: upstream !== undefined ? `${upstream}（provider 级）`
				: "(自动检测)";
			return { value: def.key, label: `${def.key}: ${state}`, description: def.description };
		});
		items.push({ value: "__raw__", label: "＋ 其他键（手动输入键名）", description: "schema 未列出但 pi 支持的键" });
		items.push({ value: "__clear__", label: "清空全部 compat", description: "整份删除，全部回退自动检测" });

		const action = await pick(ctx, `${title}（compat ${Object.keys(compat).length} 键）`, items);
		if (action === null) return;

		const applyKey = (key: string, value: unknown | undefined) => {
			const next: Record<string, unknown> = { ...read().compat };
			value === undefined ? delete next[key] : (next[key] = value);
			save(Object.keys(next).length > 0 ? next : undefined);
			ctx.ui.notify("已保存", "info");
		};

		if (action === "__clear__") {
			if (await ctx.ui.confirm("清空 compat", `删除 ${title} 的全部 compat 键？`)) {
				save(undefined);
				ctx.ui.notify("已清空", "info");
			}
			continue;
		}

		let def = defs.find((d) => d.key === action);
		if (action === "__raw__") {
			const k = await ctx.ui.input("compat 键名:", "");
			if (!k?.trim()) continue;
			const key = k.trim();
			const v = await pick(ctx, key, [
				{ value: "true", label: "true" },
				{ value: "false", label: "false" },
				{ value: "__text__", label: "输入字符串值…", description: "枚举类键选这个" },
				{ value: "", label: "(清除)" },
			]);
			if (v === null) continue;
			if (v === "__text__") {
				const s = await ctx.ui.input("值:", "");
				if (s === undefined || !s.trim()) continue;
				applyKey(key, s.trim());
			} else {
				applyKey(key, v === "" ? undefined : v === "true");
			}
			continue;
		}
		if (!def) continue;

		if (def.values) {
			const v = await pick(ctx, def.key, [
				...def.values.map((t) => ({ value: t, label: t })),
				{ value: "", label: "(清除，自动检测)" },
			]);
			if (v !== null) applyKey(def.key, v === "" ? undefined : v);
		} else {
			const v = await pick(ctx, def.key, [
				{ value: "true", label: "true", description: "启用" },
				{ value: "false", label: "false", description: "显式关闭" },
				{ value: "", label: "(清除，自动检测)" },
			]);
			if (v !== null) applyKey(def.key, v === "" ? undefined : v === "true");
		}
	}
}

// ---------- modelOverrides（最高优先级覆盖层；schema 不允许覆盖 api/baseUrl） ----------

function providerModelOverrides(p: ProviderCfg): Record<string, ModelEntry> {
	return p.modelOverrides && typeof p.modelOverrides === "object" && !Array.isArray(p.modelOverrides)
		? (p.modelOverrides as Record<string, ModelEntry>)
		: {};
}

async function editOverride(
	ctx: ExtensionCommandContext,
	providerId: string,
	overrideId: string,
): Promise<void> {
	for (;;) {
		const cfg = loadModelsJson();
		const p = cfg.providers[providerId];
		const ov = providerModelOverrides(p)[overrideId];
		if (!ov) {
			ctx.ui.notify("override 已不存在", "warning");
			return;
		}
		const pCompat = p.compat && typeof p.compat === "object" && !Array.isArray(p.compat)
			? { ...(p.compat as Record<string, unknown>) }
			: undefined;
		const compatCount = Object.keys(getCompat(ov)).length;
		const headerCount = Object.keys(headersOf(ov)).length;

		const action = await pick(ctx, `override ${providerId}/${overrideId}（最终覆盖层，不可改 api/baseUrl）`, [
			{ value: "compat", label: `compat: ${compatCount} 键`, description: "缓存/思考协议兼容开关（最高优先级）" },
			{ value: "headers", label: `headers: ${headerCount} 个`, description: "请求头覆盖" },
			{ value: "reasoning", label: `reasoning: ${ov.reasoning === undefined ? "(继承模型)" : String(ov.reasoning)}`, description: "是否支持思考" },
			{ value: "thinkingLevelMap", label: `thinkingLevelMap: ${summarizeThinkingLevelMap(ov)}`, description: "思考档位映射" },
			{ value: "contextWindow", label: `contextWindow: ${ov.contextWindow ?? "(继承模型)"}`, description: "上下文窗口" },
			{ value: "maxTokens", label: `maxTokens: ${ov.maxTokens ?? "(继承模型)"}`, description: "最大输出 tokens" },
			{ value: "delete", label: "删除此 override", description: overrideId },
		]);
		if (action === null) return;

		const persist = (mut: (o: ModelEntry) => void): void => {
			const fresh = loadModelsJson();
			const target = providerModelOverrides(fresh.providers[providerId])[overrideId];
			if (!target) return;
			mut(target);
			saveModelsJson(fresh);
		};

		try {
			if (action === "compat") {
				await editCompatRecord(
					ctx,
					`override ${overrideId}`,
					() => {
						const cur = providerModelOverrides(loadModelsJson().providers[providerId])[overrideId];
						return { compat: cur ? getCompat(cur) : {}, providerCompat: pCompat, api: p.api as string | undefined };
					},
					(next) => persist((o) => { next ? (o.compat = next) : delete o.compat; }),
				);
			} else if (action === "headers") {
				await editHeadersRecord(ctx, `override ${overrideId}`, {
					read: () => headersOf(providerModelOverrides(loadModelsJson().providers[providerId])[overrideId]),
					save: (next) => persist((o) => { next ? (o.headers = next) : delete o.headers; }),
				});
			} else if (action === "reasoning") {
				const v = await pick(ctx, "reasoning", [
					{ value: "true", label: "true" },
					{ value: "false", label: "false" },
					{ value: "", label: "(继承模型)" },
				]);
				if (v !== null) {
					persist((o) => { v === "" ? delete o.reasoning : (o.reasoning = v === "true"); });
					ctx.ui.notify("已保存", "info");
				}
			} else if (action === "thinkingLevelMap") {
				await editThinkingLevelMap(
					ctx,
					`${providerId}/${overrideId} (override)`,
					() => providerModelOverrides(loadModelsJson().providers[providerId])[overrideId],
					(updater) => { persist(updater); return true; },
				);
			} else if (action === "contextWindow" || action === "maxTokens") {
				const cur = ov[action];
				const v = await ctx.ui.input(`${action} (数字，留空清除):`, cur === undefined ? "" : String(cur));
				if (v !== undefined) {
					const n = Number(v.trim());
					if (v.trim() && (!Number.isFinite(n) || n <= 0)) {
						ctx.ui.notify("必须是正整数", "error");
						continue;
					}

					persist((o) => { v.trim() ? (o[action] = Math.round(n)) : delete o[action]; });
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "delete") {
				const ok = await ctx.ui.confirm("删除 override", `删除 ${overrideId} 的 override？`);
				if (ok) {
					const fresh = loadModelsJson();
					const overs = providerModelOverrides(fresh.providers[providerId]);
					delete overs[overrideId];
					if (Object.keys(overs).length > 0) fresh.providers[providerId].modelOverrides = overs;
					else delete fresh.providers[providerId].modelOverrides;
					saveModelsJson(fresh);
					ctx.ui.notify("已删除", "info");
					return;
				}
			}

		} catch (e) {
			ctx.ui.notify(`操作失败: ${e instanceof Error ? e.message : e}`, "error");
		}

	}
}

async function manageModelOverrides(ctx: ExtensionCommandContext, providerId: string): Promise<void> {
	for (;;) {
		const cfg = loadModelsJson();
		const p = cfg.providers[providerId];
		if (!p) {
			ctx.ui.notify("供应商已不存在", "warning");
			return;
		}

		const overrides = providerModelOverrides(p);
		const items: SelectItem[] = Object.keys(overrides).sort().map((id) => ({
			value: id,
			label: id,
			description: Object.keys(overrides[id]).join(", ") || "空 override",
		}));
		items.push({ value: "__add__", label: "＋ 新增 override", description: "针对单个模型的最终覆盖" });

		const chosen = await pick(ctx, `modelOverrides (${Object.keys(overrides).length} 个)`, items);
		if (chosen === null) return;

		if (chosen === "__add__") {
			const modelIds = (p.models ?? []).map((m) => String(m.id));
			const id = await pick(ctx, "选择要覆盖的模型", [
				...modelIds.map((v) => ({ value: v, label: v })),
				{ value: "__manual__", label: "手动输入…", description: "不在 models 列表中的模型 id" },
			]);
			if (id === null) continue;
			let target = id;
			if (id === "__manual__") {
				const v = await ctx.ui.input("模型 id:", "");
				if (!v?.trim()) continue;
				target = v.trim();
			}
			const fresh = loadModelsJson();
			const pp = fresh.providers[providerId];
			const overs = providerModelOverrides(pp);
			overs[target] = overs[target] ?? {};
			pp.modelOverrides = overs;
			saveModelsJson(fresh);
			await editOverride(ctx, providerId, target);
		} else {
			await editOverride(ctx, providerId, chosen);
		}
	}
}
async function manageProvider(ctx: ExtensionCommandContext, providerId: string): Promise<void> {
	for (;;) {
		let p: ProviderCfg;
		try {
			p = loadModelsJson().providers[providerId];
		} catch (e) {
			ctx.ui.notify(`models.json 解析失败: ${e instanceof Error ? e.message : e}`, "error");
			return;
		}
		if (!p) {
			ctx.ui.notify("供应商已不存在", "warning");
			return;
		}

		const compatCount = Object.keys(getCompat(p as unknown as ModelEntry)).length;
		const headerCount = Object.keys(headersOf(p)).length;
		const overrideCount = Object.keys(providerModelOverrides(p)).length;
		const apiKeyLabel = !p.apiKey ? "(未配置)"
			: p.apiKey.startsWith("$") ? p.apiKey
			: p.apiKey.startsWith("!") ? "!command"
			: "已配置(不回显)";

		const action = await pick(ctx, `供应商 ${providerId}`, [
			{
				value: "add",
				label: `添加模型 (接口拉取, 当前 ${p.models?.length ?? 0} 个)`,
				description: `${(p.baseUrl ?? "").replace(/\/+$/, "")}/models`,
			},
			{ value: "add-manual", label: "添加模型 (手动输入)", description: "接口不可用时使用" },
			{ value: "edit", label: "编辑模型", description: "模型级 api / compat / headers / 参数覆盖" },
			{ value: "remove", label: "删除模型", description: "从列表选择" },
			{ value: "overrides", label: `modelOverrides: ${overrideCount} 个`, description: "单模型最终覆盖层（compat/headers/参数）" },
			{ value: "compat", label: `compat: ${compatCount} 键`, description: "供应商级缓存/思考协议兼容开关，全部模型继承" },
			{ value: "headers", label: `headers: ${headerCount} 个`, description: "供应商级请求头，全部模型继承" },
			{ value: "baseUrl", label: `baseUrl: ${p.baseUrl ?? "(无)"}`, description: "编辑；anthropic/gemini 自动去除结尾版本段" },
			{ value: "apiKey", label: `apiKey: ${apiKeyLabel}`, description: "支持 $ENV_VAR 引用" },
			{ value: "api", label: `API 类型: ${p.api ?? "(无)"}`, description: "修改 API 类型" },
			{ value: "authHeader", label: `authHeader: ${p.authHeader === undefined ? "(默认)" : String(p.authHeader)}`, description: "是否以 Authorization: Bearer 携带 key" },
			{ value: "name", label: `name: ${typeof p.name === "string" ? p.name : "(无)"}`, description: "显示名称" },
			{ value: "delete", label: "删除此供应商", description: "含全部模型定义" },
		]);
		if (action === null) return;

		try {
			if (action === "add") await addModelsFromEndpoint(ctx, providerId);
			else if (action === "add-manual") await addModelManual(ctx, providerId);
			else if (action === "edit") await editModelEntry(ctx, providerId);
			else if (action === "remove") await removeModel(ctx, providerId);
			else if (action === "overrides") await manageModelOverrides(ctx, providerId);
			else if (action === "compat") {
				await editCompatRecord(
					ctx,
					`供应商 ${providerId}`,
					() => {
						const fresh = loadModelsJson().providers[providerId];
						return {
							compat: getCompat(fresh as unknown as ModelEntry),
							api: typeof fresh.api === "string" ? fresh.api : undefined,
						};
					},
					(next) => {
						const cfg = loadModelsJson();
						const target = cfg.providers[providerId];
						next ? (target.compat = next) : delete target.compat;
						saveModelsJson(cfg);
					},
				);

			} else if (action === "headers") {
				await editHeadersRecord(ctx, `供应商 ${providerId}`, {
					read: () => headersOf(loadModelsJson().providers[providerId]),
					save: (next) => {
						const cfg = loadModelsJson();
						const target = cfg.providers[providerId];
						next ? (target.headers = next) : delete target.headers;
						saveModelsJson(cfg);
					},
				});

			} else if (action === "baseUrl") {
				const v = await ctx.ui.input("baseUrl:", p.baseUrl ?? "");
				if (v?.trim()) {
					const { url, stripped } = stripVersionSuffix(typeof p.api === "string" ? p.api : undefined, v.trim());
					const cfg = loadModelsJson();
					cfg.providers[providerId].baseUrl = url;
					saveModelsJson(cfg);
					ctx.ui.notify(stripped ? `已保存（自动去除结尾版本段 → ${url}）` : "已保存", "info");
				}

			} else if (action === "apiKey") {
				const mode = await pick(ctx, "apiKey", [
					{ value: "set", label: "设置 / 更换", description: p.apiKey && !p.apiKey.startsWith("$") && !p.apiKey.startsWith("!") ? "当前为明文，不回显" : "输入新值" },
					{ value: "clear", label: "清除", description: "删除已存 apiKey" },
				]);
				if (mode === "set") {
					const v = await ctx.ui.input("新 apiKey (支持 $ENV_VAR):", "");
					if (v?.trim()) {
						const cfg = loadModelsJson();
						const target = cfg.providers[providerId];
						target.apiKey = v.trim();
						if (target.authHeader === undefined) target.authHeader = true;
						saveModelsJson(cfg);
						ctx.ui.notify("已保存", "info");
					}

				} else if (mode === "clear") {
					const ok = await ctx.ui.confirm("清除 apiKey", `删除 ${providerId} 的 apiKey？`);
					if (ok) {
						const cfg = loadModelsJson();
						delete cfg.providers[providerId].apiKey;
						saveModelsJson(cfg);
						ctx.ui.notify("已清除", "info");
					}
				}

			} else if (action === "api") {
				const v = await pick(ctx, "API 类型", API_TYPES.map((t) => ({ value: t, label: t })));
				if (v !== null) {
					const cfg = loadModelsJson();
					const target = cfg.providers[providerId];
					target.api = v;
					const baseUrl = typeof target.baseUrl === "string" ? target.baseUrl : "";
					const { url, stripped } = stripVersionSuffix(v, baseUrl);
					if (stripped) target.baseUrl = url;
					saveModelsJson(cfg);
					ctx.ui.notify(stripped ? `已保存（baseUrl 自动去除结尾版本段 → ${url}）` : "已保存", "info");
				}

			} else if (action === "authHeader") {
				const v = await pick(ctx, "authHeader", [
					{ value: "true", label: "true", description: "Authorization: Bearer <key>" },
					{ value: "false", label: "false", description: "不带 Authorization 头" },
					{ value: "", label: "(默认)" },
				]);
				if (v !== null) {
					const cfg = loadModelsJson();
					const target = cfg.providers[providerId];
					v === "" ? delete target.authHeader : (target.authHeader = v === "true");
					saveModelsJson(cfg);
					ctx.ui.notify("已保存", "info");
				}

			} else if (action === "name") {
				const v = await ctx.ui.input("显示名称 (留空清除):", typeof p.name === "string" ? p.name : "");
				if (v !== undefined) {
					const cfg = loadModelsJson();
					const target = cfg.providers[providerId];
					v.trim() ? (target.name = v.trim()) : delete target.name;
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
				let agents: AgentFile[];
				try {
					agents = listAgents();
				} catch (e) {
					ctx.ui.notify(`读取 agents 目录失败: ${e instanceof Error ? e.message : e}`, "error");
					return;
				}
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
				let cfg: ModelsJson;
				try {
					cfg = loadModelsJson();
				} catch (e) {
					ctx.ui.notify(`models.json 解析失败: ${e instanceof Error ? e.message : e}`, "error");
					return;
				}
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
