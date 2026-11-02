/**
 * Endpoint base handling.
 *
 * Pi passes `model.baseUrl` straight to the SDK as `baseURL` and never normalises it, while the SDKs
 * disagree about where the API version lives: the OpenAI SDK requests `/chat/completions` and
 * `/responses` (so the base must carry the version segment), whereas the Anthropic SDK requests
 * `/v1/messages` and the Google SDK `/v1beta/...` (so the base must not). The extension therefore
 * stores one canonical base per provider and derives the SDK-shaped form per API type.
 */

/** APIs whose SDK appends its own versioned path, so the stored base must be free of a version segment. */
const SELF_VERSIONED_APIS = new Set([
	"anthropic-messages", "google-generative-ai", "google-vertex", "mistral-conversations",
	"azure-openai-responses",
]);

/** APIs whose SDK needs the version segment inside the base URL. */
const OPENAI_VERSIONED_APIS = new Set(["openai-completions", "openai-responses", "openai-codex-responses"]);

/** The version segment OpenAI-family bases get when the endpoint does not name one. */
const DEFAULT_VERSION_SEGMENT = "/v1";

const VERSION_SEGMENT_RE = /\/v\d+[a-z]*$/i;

function parse(value: string): URL | undefined {
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
		return url;
	} catch { return undefined; }
}

/** The version segment an endpoint was configured with, e.g. `/v1` or `/v4`; undefined when absent. */
export function versionSegment(baseUrl: string): string | undefined {
	const url = parse(baseUrl.trim());
	if (!url) return undefined;
	return VERSION_SEGMENT_RE.exec(url.pathname.replace(/\/+$/, ""))?.[0];
}

/** Host plus path prefix with the trailing version segment removed, and no trailing slash. */
export function canonicalBase(baseUrl: string): string {
	const value = baseUrl.trim();
	const url = parse(value);
	if (!url) return value;
	const path = url.pathname.replace(/\/+$/, "").replace(VERSION_SEGMENT_RE, "");
	return `${url.origin}${path}${url.search}${url.hash}`;
}

/**
 * The form pi must store for this API type: OpenAI-family keeps (or gains) a version segment, SDKs
 * that build their own versioned path take the bare base. Values pi cannot rewrite safely - an
 * unknown API type, embedded credentials, or a base carrying a query or fragment - are returned as
 * typed, so derivation never mangles an endpoint someone configured by hand.
 */
export function deriveBaseUrl(api: string | undefined, baseUrl: string): string {
	const value = baseUrl.trim();
	const url = parse(value);
	if (!url || !api || url.search || url.hash) return value;
	const base = canonicalBase(value);
	if (SELF_VERSIONED_APIS.has(api)) return base;
	if (OPENAI_VERSIONED_APIS.has(api)) return `${base}${versionSegment(value) ?? DEFAULT_VERSION_SEGMENT}`;
	return value;
}

/** True when the stored value already matches what this API type needs, so nothing has to be rewritten. */
export function baseUrlMatchesApi(api: string | undefined, baseUrl: string): boolean {
	return deriveBaseUrl(api, baseUrl) === baseUrl.trim();
}
