import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

test("real /providers menu saves only transport settings and leaves models/credentials unchanged", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-command-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		for (const file of readdirSync(dir)) unlinkSync(join(dir, file));
		rmdirSync(dir);
	});
	const initial = JSON.stringify({ providers: { cpa: { api: "openai-responses", baseUrl: "https://offline.invalid/v1", apiKey: "dummy", models: [{ id: "dummy-model" }] } } });
	writeFileSync(join(dir, "models.json"), initial);
	const { default: extension } = await import("../extensions/agent-manager.ts");
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	extension({ on: () => {}, registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command) } as unknown as ExtensionAPI);
	const choices: (string | null)[] = ["cpa", "传输方式", "transport", "websocket", null, null, null];
	const notices: string[] = [];
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		mode: "tui",
		modelRegistry: { getAll: () => [{ provider: "cpa", id: "dummy-model", api: "openai-responses" }] },
		ui: {
			notify: (text: string) => notices.push(text),
			custom: (build: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { handleInput(data: string): void }) => new Promise((resolve) => {
				assert.ok(choices.length, "unexpected menu");
				const component = build({ requestRender: () => {} }, theme, {}, resolve);
				const choice = choices.shift();
				if (choice === null) component.handleInput("\x1b");
				else { component.handleInput(choice!); component.handleInput("\r"); }
			}),
		},
	} as unknown as ExtensionCommandContext;
	await commands.get("providers")!.handler("", ctx);
	assert.equal(choices.length, 0);
	assert.equal(readFileSync(join(dir, "models.json"), "utf8"), initial);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "provider-transports.json"), "utf8")), { providers: { cpa: { transport: "websocket" } } });
	assert.ok(notices.some((notice) => notice.includes("/reload")));
	await commands.get("providers")!.handler("", { ...ctx, mode: "json" });
	assert.ok(notices.at(-1)?.includes("仅在 TUI"));
});
