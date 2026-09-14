/** Pi-compatible interpolation without evaluating shell commands. */
export function resolveSecret(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!value || value.startsWith("!")) return undefined;
	let result = "";
	for (let i = 0; i < value.length;) {
		if (value[i] !== "$") { result += value[i++]; continue; }
		const next = value[i + 1];
		if (next === "$" || next === "!") { result += next; i += 2; continue; }
		if (next === "{") {
			const end = value.indexOf("}", i + 2);
			if (end === -1) { result += value[i++]; continue; }
			const name = value.slice(i + 2, end);
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
				if (!env[name]) return undefined;
				result += env[name];
			} else result += value.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		const name = value.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
		if (!name) { result += value[i++]; continue; }
		if (!env[name]) return undefined;
		result += env[name]; i += name.length + 1;
	}
	return result;
}

export function modelsListUrl(baseUrl: string, api?: string): URL {
	const url = new URL(baseUrl);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("模型列表地址必须是无内嵌凭据的 HTTP(S) URL");
	let path = url.pathname.replace(/\/+$/, "");
	if (!/\/v\d+[a-z]*$/i.test(path)) {
		if (api === "anthropic-messages") path += "/v1";
		else if (api === "google-generative-ai") path += "/v1beta";
	}
	url.pathname = path + "/models";
	return url;
}

export async function fetchEndpointModels(baseUrl: string, headers: Record<string, string> = {}, api?: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string[]> {
	const url = modelsListUrl(baseUrl, api);
	const ids = new Set<string>();
	const cursors = new Set<string>();
	const signal = AbortSignal.timeout(10_000);
	for (let page = 0; page < 100; page++) {
		const response = await fetchImpl(url.href, { headers, signal, redirect: "error" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		let data: { models?: { name?: unknown }[]; data?: { id?: unknown }[]; nextPageToken?: unknown; has_more?: unknown; last_id?: unknown };
		try { data = await response.json(); } catch { throw new Error("模型列表不是有效 JSON"); }
		if (!data || typeof data !== "object") throw new Error("无法识别模型列表响应");
		const nativeGoogle = api === "google-generative-ai" && Array.isArray(data.models);
		const records = nativeGoogle ? data.models : data.data;
		if (!Array.isArray(records)) throw new Error("无法识别模型列表响应");
		for (const record of records) {
			if (!record || typeof record !== "object") continue;
			const id = nativeGoogle ? (record as { name?: unknown }).name : (record as { id?: unknown }).id;
			if (typeof id === "string") {
				const normalized = nativeGoogle ? id.replace(/^models\//, "") : id;
				if (normalized.trim()) ids.add(normalized);
			}
		}
		const cursor = nativeGoogle ? data.nextPageToken : api === "anthropic-messages" && data.has_more ? data.last_id ?? data.data?.at(-1)?.id : undefined;
		if (cursor === undefined || cursor === "") {
			if (api === "anthropic-messages" && data.has_more) throw new Error("模型列表分页缺少游标");
			return [...ids].sort();
		}
		if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("模型列表分页游标无效或重复");
		cursors.add(cursor);
		url.searchParams.set(nativeGoogle ? "pageToken" : "after_id", cursor);
	}
	throw new Error("模型列表分页超过安全上限");
}

export function positiveInteger(value: string): number | undefined {
	if (!value.trim()) return undefined;
	const number = Number(value.trim());
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("必须是正安全整数");
	return number;
}
