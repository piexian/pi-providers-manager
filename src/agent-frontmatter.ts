import { closeSync, fchmodSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isMap, isScalar, parseDocument } from "yaml";

export const MANAGED_AGENT_KEYS = ["name", "description", "tools", "model", "thinkingLevel"] as const;

function document(source: string) {
	const doc = parseDocument(source, { keepSourceTokens: true, uniqueKeys: true });
	if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) throw new Error("frontmatter 必须是有效的 YAML 映射；未修改文件");
	try { doc.toJS({ maxAliasCount: 100 }); } catch { throw new Error("frontmatter 包含无效别名；未修改文件"); }
	return doc;
}

export function parseAgentFields(source: string): Record<string, string> {
	const doc = document(source);
	const fields: Record<string, string> = {};
	const data = doc.toJS() ?? {};
	for (const key of MANAGED_AGENT_KEYS) {
		const value = data[key];
		if (typeof value === "string") fields[key] = value;
		else if (key === "tools" && Array.isArray(value) && value.every((item) => typeof item === "string")) fields[key] = value.join(",");
	}
	return fields;
}

/** Replace a complete YAML value range while keeping unrelated source and prompt bytes. */
export function editAgentField(content: string, key: string, value: string | undefined): string {
	if (!(MANAGED_AGENT_KEYS as readonly string[]).includes(key)) throw new Error("不支持的 agent 字段");
	const match = content.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))([\s\S]*)$/);
	if (!match) throw new Error("frontmatter 格式无法识别；未修改文件");
	const newline = match[1].endsWith("\r\n") ? "\r\n" : "\n";
	const source = match[2];
	const doc = document(source);
	if (isMap(doc.contents) && doc.contents.flow) throw new Error("暂不编辑流式 YAML 映射；未修改文件");
	const pair = isMap(doc.contents) ? doc.contents.items.find((item) => isScalar(item.key) && item.key.value === key) : undefined;
	const remove = value === undefined || value === "";
	let next = source;
	if (pair) {
		const keyNode = pair.key;
		const node = pair.value;
		if (!keyNode?.range || !node?.range) throw new Error("无法安全定位 YAML 字段；未修改文件");
		if (remove) {
			const start = source.lastIndexOf("\n", keyNode.range[0] - 1) + 1;
			next = source.slice(0, start) + source.slice(Math.min(node.range[2], source.length));
		} else {
			const [start, rawEnd] = node.range;
			const end = Math.min(rawEnd, source.length);
			const old = source.slice(start, end);
			const token = node.srcToken;
			const commentToken = token?.type === "block-scalar" ? token.props.find((part) => part.type === "comment") : undefined;
			const comment = commentToken && "source" in commentToken ? commentToken.source : undefined;
			const space = source[start - 1] === ":" ? " " : "";
			const replacement = space + JSON.stringify(value) + (comment ? ` ${comment}` : "") + (old.endsWith("\n") ? newline : "");
			next = source.slice(0, start) + replacement + source.slice(end);
		}
	} else if (!remove) {
		next += (next && !next.endsWith("\n") ? newline : "") + `${key}: ${JSON.stringify(value)}`;
	}
	const checked = document(next);
	if (remove ? checked.has(key) : checked.get(key) !== value) throw new Error("YAML 写回校验失败；未修改文件");
	return match[1] + next + match[3] + match[4];
}

export function setAgentField(path: string, key: string, value: string | undefined): void {
	const target = realpathSync(path);
	const before = readFileSync(target, "utf8");
	const next = editAgentField(before, key, value);
	if (next === before) return;
	const stat = statSync(target);
	if (!stat.isFile()) throw new Error("agent 路径不是普通文件");
	const temp = `${target}.${randomUUID()}.tmp`;
	const fd = openSync(temp, "wx", stat.mode & 0o777);
	try {
		try { fchmodSync(fd, stat.mode & 0o777); writeFileSync(fd, next, "utf8"); } finally { closeSync(fd); }
		if (readFileSync(target, "utf8") !== before) throw new Error("agent 文件已被其他进程修改，请重试");
		renameSync(temp, target);
	} finally {
		try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
