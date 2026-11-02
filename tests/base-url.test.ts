import assert from "node:assert/strict";
import { test } from "node:test";
import { baseUrlMatchesApi, canonicalBase, deriveBaseUrl, versionSegment } from "../src/base-url.ts";

test("canonical base keeps the path prefix and drops only the trailing version segment", (t) => {
	const cases: [string, string][] = [
		["https://cpa.example.net/v1", "https://cpa.example.net"],
		["https://cpa.example.net/v1/", "https://cpa.example.net"],
		["http://192.168.31.95:3000/v1", "http://192.168.31.95:3000"],
		["http://192.168.31.95:3000/", "http://192.168.31.95:3000"],
		["https://api.groq.com/openai/v1", "https://api.groq.com/openai"],
		["https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
			"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode"],
		["https://open.bigmodel.cn/api/coding/paas/v4", "https://open.bigmodel.cn/api/coding/paas"],
		["https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com"],
		["https://api.anthropic.com", "https://api.anthropic.com"],
		["https://host.example/v1?key=1", "https://host.example?key=1"],
	];
	for (const [input, expected] of cases) assert.equal(canonicalBase(input), expected, input);
});

test("the version segment is reported for the stored form", (t) => {
	assert.equal(versionSegment("https://host/v1"), "/v1");
	assert.equal(versionSegment("https://host/api/paas/v4"), "/v4");
	assert.equal(versionSegment("https://host/v1beta/"), "/v1beta");
	assert.equal(versionSegment("https://host"), undefined);
	assert.equal(versionSegment("https://host/v1/models"), undefined);
	assert.equal(versionSegment("not a url"), undefined);
});

test("OpenAI-family bases gain a version segment, self-versioned SDKs lose it", (t) => {
	assert.equal(deriveBaseUrl("openai-completions", "http://192.168.31.95:3000"), "http://192.168.31.95:3000/v1");
	assert.equal(deriveBaseUrl("openai-responses", "https://cpa.example.net"), "https://cpa.example.net/v1");
	assert.equal(deriveBaseUrl("openai-codex-responses", "https://host/v4"), "https://host/v4");
	assert.equal(deriveBaseUrl("anthropic-messages", "https://host/v1"), "https://host");
	assert.equal(deriveBaseUrl("google-generative-ai", "https://host/v1beta"), "https://host");
	assert.equal(deriveBaseUrl("mistral-conversations", "https://host/v1"), "https://host");
	assert.equal(deriveBaseUrl("azure-openai-responses", "https://host/openai/v1"), "https://host/openai");
});

test("an unknown API type or an unparseable value is never rewritten", (t) => {
	assert.equal(deriveBaseUrl(undefined, "https://host"), "https://host");
	assert.equal(deriveBaseUrl("brand-new-api", "https://host"), "https://host");
	assert.equal(deriveBaseUrl("openai-completions", "http://user:pass@host/v1"), "http://user:pass@host/v1");
	assert.equal(deriveBaseUrl("openai-completions", "https://host/v1?key=1"), "https://host/v1?key=1");
	assert.equal(deriveBaseUrl("anthropic-messages", "https://host/v1#frag"), "https://host/v1#frag");
	assert.equal(deriveBaseUrl("openai-completions", "  https://host/v1  "), "https://host/v1");
});

test("derivation round-trips: switching API types back and forth restores the stored form", (t) => {
	for (const stored of ["https://host/v1", "https://host:1234/gateway/v1", "http://192.168.31.95:3000/v1"]) {
		const anthropic = deriveBaseUrl("anthropic-messages", stored);
		assert.equal(anthropic, canonicalBase(stored));
		assert.equal(deriveBaseUrl("openai-responses", anthropic), stored, stored);
		assert.equal(deriveBaseUrl("openai-responses", deriveBaseUrl("openai-responses", anthropic)), stored);
	}
});

test("derivation is idempotent for every API type it knows", (t) => {
	const apis = ["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages",
		"google-generative-ai", "google-vertex", "mistral-conversations", "azure-openai-responses"];
	for (const stored of ["https://host/v1", "https://host/api/paas/v4", "https://host", "https://host/"]) {
		for (const api of apis) {
			const once = deriveBaseUrl(api, stored);
			assert.equal(deriveBaseUrl(api, once), once, `${api} ${stored}`);
			assert.equal(canonicalBase(once), canonicalBase(stored), `${api} ${stored} canonical drift`);
		}
	}
});

test("matching tells the UI whether a switch has to rewrite the endpoint", (t) => {
	assert.equal(baseUrlMatchesApi("openai-responses", "https://host/v1"), true);
	assert.equal(baseUrlMatchesApi("anthropic-messages", "https://host/v1"), false);
	assert.equal(baseUrlMatchesApi("anthropic-messages", "https://host"), true);
	assert.equal(baseUrlMatchesApi(undefined, "https://host/v1"), true);
});
