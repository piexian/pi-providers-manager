import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

test("real provider menus reject fractional caps, resolve native lists and disambiguate metadata", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-settings-test-"));
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_AUDIT_KEY: process.env.PI_AUDIT_KEY };
	process.env.PI_CODING_AGENT_DIR = dir; process.env.PI_AUDIT_KEY = "dummy";
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir);
	});
	const path = join(dir, "models.json");
	const initial = (api = "openai-responses") => ({ providers: { cpa: { api, baseUrl: "https://host.invalid", apiKey: "${PI_AUDIT_KEY}_suffix", models: [{ id: "dummy-model", maxTokens: 100 }], modelOverrides: { "dummy-model": { maxTokens: 200 } } } } });
	const { default: extension, getBody, setBody, setField, readAgent } = await import("../extensions/agent-manager.ts");
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	extension({ on: () => {}, registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command) } as unknown as ExtensionAPI);
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input); requests.push(url);
		if (url === "https://models.dev/api.json") return Response.json({ a: { models: { shared: { name: "A", limit: { context: 1000, output: 100 } } } }, b: { models: { shared: { name: "B", limit: { context: 200000, output: 20000 } } } } });
		if (url === "https://host.invalid/v1/models") { assert.equal(new Headers(init?.headers).get("x-api-key"), "dummy_suffix"); return Response.json({ data: [{ id: "claude-test" }] }); }
		if (url === "https://host.invalid/v1beta/models") { assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "dummy_suffix"); return Response.json({ models: [{ name: "models/gemini-test" }] }); }
		throw new Error("Unexpected fixture request");
	});
	async function run(choices: (string | null)[], inputs: string[]) {
		const notices: string[] = [];
		const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
		const ctx = { mode: "tui", ui: {
			notify: (text: string) => notices.push(text),
			input: async () => { assert.ok(inputs.length, "unexpected input"); return inputs.shift(); },
			custom: (build: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { handleInput(data: string): void }) => new Promise((resolve, reject) => {
				assert.ok(choices.length, "unexpected menu"); let done = false;
				const component = build({ requestRender: () => {} }, theme, {}, (value) => { done = true; resolve(value); });
				const choice = choices.shift();
				if (choice === null) component.handleInput("\x1b"); else { component.handleInput(choice!); component.handleInput("\r"); }
				if (!done) reject(new Error(`menu choice not found: ${choice}`));
			}),
		} } as unknown as ExtensionCommandContext;
		await commands.get("providers")!.handler("", ctx);
		assert.equal(choices.length, 0); assert.equal(inputs.length, 0);
		return notices;
	}
	await t.test("agent entrypoints read multiline YAML and keep BOM out of prompt editing", () => {
		const agent = join(dir, "agent.md");
		writeFileSync(agent, "\uFEFF---\r\nname: demo\r\ndescription: |\r\n  old first\r\n  old second\r\n---\r\nPrompt");
		assert.equal(readAgent(agent)?.description, "old first\nold second\n");
		assert.equal(getBody(agent), "Prompt");
		setField(agent, "description", "new description");
		setBody(agent, "New prompt");
		assert.equal(readAgent(agent)?.description, "new description");
		assert.equal(getBody(agent), "New prompt");
		assert.ok(readFileSync(agent, "utf8").startsWith("\uFEFF---\r\n"));
	});
	await t.test("model cap invalid input does not write JSON", async () => {
		const before = JSON.stringify(initial()); writeFileSync(path, before);
		const notices = await run(["cpa", "edit", "dummy-model", "maxTokens", null, null, null], ["0.1"]);
		assert.equal(readFileSync(path, "utf8"), before); assert.ok(notices.some((text) => text.includes("正安全整数")));
	});
	await t.test("override cap invalid input does not write JSON", async () => {
		const before = JSON.stringify(initial()); writeFileSync(path, before);
		const notices = await run(["cpa", "overrides", "dummy-model", "maxTokens", null, null, null, null], ["0.1"]);
		assert.equal(readFileSync(path, "utf8"), before); assert.ok(notices.some((text) => text.includes("正安全整数")));
	});
	await t.test("ambiguous metadata requires the chosen vendor or an explicit skip", async () => {
		for (const choice of ["b / shared", "跳过元数据"]) {
			writeFileSync(path, JSON.stringify(initial()));
			await run(["cpa", "add-manual", choice, null, null], ["shared"]);
			const model = JSON.parse(readFileSync(path, "utf8")).providers.cpa.models.at(-1);
			assert.equal(model.id, "shared");
			assert.equal(model.contextWindow, choice === "b / shared" ? 200000 : undefined);
		}
	});
	await t.test("native list URL, auth interpolation and Gemini result all reach the real menu", async () => {
		for (const [api, id] of [["anthropic-messages", "claude-test"], ["google-generative-ai", "gemini-test"]]) {
			writeFileSync(path, JSON.stringify(initial(api)));
			await run(["cpa", "接口拉取", id, null, null, null], []);
			assert.ok(JSON.parse(readFileSync(path, "utf8")).providers.cpa.models.some((model: { id: string }) => model.id === id));
		}
	});
	await t.test("missing interpolation does not send anonymous list requests", async () => {
		const data = initial(); data.providers.cpa.apiKey = "$PI_AUDIT_UNSET"; writeFileSync(path, JSON.stringify(data));
		const count = requests.length;
		const notices = await run(["cpa", "接口拉取", null, null], []);
		assert.equal(requests.length, count); assert.ok(notices.some((text) => text.includes("未设置的环境变量")));
	});
});
