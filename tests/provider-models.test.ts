import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSecret, modelsListUrl, fetchEndpointModels, positiveInteger } from "../src/provider-models.ts";
import { indexModelsDev, lookupModelsDev, modelsDevCandidates } from "../src/models-dev.ts";

test("Pi interpolation supports embedded references, escapes and unresolved variables without commands", () => {
	const env = { KEY: "dummy", PREFIX: "prefix", SUFFIX: "suffix" };
	for (const [value, expected] of [["$KEY", "dummy"], ["${PREFIX}_${SUFFIX}", "prefix_suffix"], ["Bearer $KEY", "Bearer dummy"], ["$$literal", "$literal"], ["$!literal", "!literal"], ["$$KEY", "$KEY"], ["${BAD-NAME}", "${BAD-NAME}"], ["$KEY/${UNSET}", undefined], ["!echo forbidden", undefined]] as const) {
		assert.equal(resolveSecret(value, env), expected, value);
	}
});

test("native list URLs restore version segments without duplicating them or losing proxy prefix/query", () => {
	for (const [api, base, expected] of [
		["anthropic-messages", "https://host.invalid/proxy", "https://host.invalid/proxy/v1/models"],
		["anthropic-messages", "https://host.invalid/v1/", "https://host.invalid/v1/models"],
		["google-generative-ai", "https://host.invalid", "https://host.invalid/v1beta/models"],
		["google-generative-ai", "https://host.invalid/v1beta", "https://host.invalid/v1beta/models"],
		["openai-responses", "https://host.invalid/v1?route=demo", "https://host.invalid/v1/models?route=demo"],
	]) assert.equal(modelsListUrl(base, api).href, expected);
	assert.throws(() => modelsListUrl("https://user:dummy@host.invalid"), /无内嵌凭据/);
});

test("native Gemini pages use models[].name; OpenAI-shaped proxy responses remain supported", async () => {
	const urls: string[] = [];
	const fetchImpl: typeof fetch = async (url, init) => {
		urls.push(String(url)); assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "dummy"); assert.equal(init?.redirect, "error");
		return Response.json(urls.length === 1 ? { models: [{ name: "models/gemini-a" }], nextPageToken: "page-2" } : { models: [{ name: "models/gemini-b" }, { name: "models/gemini-a" }] });
	};
	assert.deepEqual(await fetchEndpointModels("https://host.invalid", { "x-goog-api-key": "dummy" }, "google-generative-ai", fetchImpl), ["gemini-a", "gemini-b"]);
	assert.match(urls[1], /v1beta\/models\?pageToken=page-2/);
	assert.deepEqual(await fetchEndpointModels("https://host.invalid", {}, "google-generative-ai", async () => Response.json({ data: [{ id: "proxy-model" }] })), ["proxy-model"]);
});

test("Anthropic pagination retains cursor and rejects loops, malformed bodies and HTTP errors", async () => {
	let count = 0;
	const ids = await fetchEndpointModels("https://host.invalid", {}, "anthropic-messages", async (url) => {
		count++; if (count === 2) assert.match(String(url), /after_id=claude-a/);
		return Response.json(count === 1 ? { data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" } : { data: [{ id: "claude-b" }], has_more: false });
	});
	assert.deepEqual(ids, ["claude-a", "claude-b"]);
	await assert.rejects(fetchEndpointModels("https://host.invalid", {}, "google-generative-ai", async () => Response.json({ models: [], nextPageToken: "loop" })), /重复/);
	await assert.rejects(fetchEndpointModels("https://host.invalid", {}, undefined, async () => Response.json({ unexpected: [] })), /无法识别/);
	await assert.rejects(fetchEndpointModels("https://host.invalid", {}, undefined, async () => new Response("dummy-private-body", { status: 401 })), /^Error: HTTP 401$/);
});

test("positive integer caps reject fractions and unsafe values rather than rounding", () => {
	for (const value of ["0.1", "0.49", "1.5", "0", "-1", "Infinity", "NaN", "9007199254740992"]) assert.throws(() => positiveInteger(value), /正安全整数/);
	assert.equal(positiveInteger(" 4096 "), 4096);
	assert.equal(positiveInteger(""), undefined);
});

test("models.dev indexes preserve provider identity and never choose the first ambiguous candidate", () => {
	const a = { name: "Provider A", limit: { context: 1000, output: 100 } };
	const b = { name: "Provider B", limit: { context: 200000, output: 20000 } };
	for (const data of [{ a: { models: { shared: a } }, b: { models: { shared: b } } }, { b: { models: { shared: b } }, a: { models: { shared: a } } }]) {
		const index = indexModelsDev(data);
		assert.equal(lookupModelsDev(index, "shared", "b"), b);
		assert.equal(lookupModelsDev(index, "b/shared"), b);
		assert.equal(lookupModelsDev(index, "shared", "custom-proxy"), undefined);
		assert.deepEqual(modelsDevCandidates(index, "shared").map((candidate) => candidate.provider), ["a", "b"]);
	}
	const unique = indexModelsDev({ a: { models: { "namespace/unique": a } } });
	assert.equal(lookupModelsDev(unique, "unique", "proxy"), a);
});
