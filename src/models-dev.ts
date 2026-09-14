export interface ModelsDevEntry {
	name?: string;
	reasoning?: boolean;
	reasoning_options?: Array<{ type?: string; values?: string[] }>;
	modalities?: { input?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; output?: number };
}
export interface ModelsDevCandidate { provider: string; id: string; meta: ModelsDevEntry }
export type ModelsDevIndex = Map<string, ModelsDevCandidate[]>;
let cached: ModelsDevIndex | undefined;

export function indexModelsDev(data: Record<string, { models?: Record<string, ModelsDevEntry> }>): ModelsDevIndex {
	const index: ModelsDevIndex = new Map();
	for (const [provider, value] of Object.entries(data)) {
		for (const [id, meta] of Object.entries(value?.models ?? {})) {
			if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
			const candidate = { provider, id, meta };
			for (const key of new Set([id.toLowerCase(), `${provider}/${id}`.toLowerCase(), id.split("/").at(-1)!.toLowerCase()])) {
				const candidates = index.get(key) ?? [];
				candidates.push(candidate); index.set(key, candidates);
			}
		}
	}
	return index;
}

export function modelsDevCandidates(index: ModelsDevIndex, id: string, provider?: string): ModelsDevCandidate[] {
	const key = id.toLowerCase();
	const candidates = index.get(key) ?? index.get(key.split("/").at(-1)!) ?? [];
	const exact = candidates.filter((candidate) => candidate.id.toLowerCase() === key || `${candidate.provider}/${candidate.id}`.toLowerCase() === key);
	const matches = exact.length ? exact : candidates;
	const scoped = provider ? matches.filter((candidate) => candidate.provider.toLowerCase() === provider.toLowerCase()) : [];
	return [...(scoped.length ? scoped : matches)].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

export function lookupModelsDev(index: ModelsDevIndex, id: string, provider?: string): ModelsDevEntry | undefined {
	const matches = modelsDevCandidates(index, id, provider);
	return matches.length === 1 ? matches[0].meta : undefined;
}

export async function loadModelsDev(fetchImpl: typeof fetch = globalThis.fetch): Promise<ModelsDevIndex> {
	if (cached) return cached;
	try {
		const response = await fetchImpl("https://models.dev/api.json", { signal: AbortSignal.timeout(15_000), redirect: "error" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid models.dev response");
		cached = indexModelsDev(data);
		return cached;
	} catch { return new Map(); }
}
