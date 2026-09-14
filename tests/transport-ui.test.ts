import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransportConfigStore } from "../src/transport-config.ts";
import { editProviderTransport, type TransportUI } from "../src/transport-ui.ts";

function fixture(t: { after(fn: () => void): void }, choices: (string | null)[], inputs: (string | undefined)[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-ui-test-"));
	t.after(() => { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
	const store = new TransportConfigStore(join(dir, "provider-transports.json"));
	const notifications: { message: string; type: string }[] = [];
	const menus: { title: string; items: { value: string; label: string; description?: string }[] }[] = [];
	const ui: TransportUI = {
		async pick(title, items) { menus.push({ title, items }); assert.ok(choices.length, `Unexpected menu ${title}`); return choices.shift()!; },
		async input() { assert.ok(inputs.length); return inputs.shift(); },
		notify(message, type) { notifications.push({ message, type }); },
	};
	return { store, ui, menus, notifications };
}

test("transport menu exposes all modes, applies provider scope and documents reload", async (t) => {
	const { store, ui, menus, notifications } = fixture(t, ["transport", "websocket", null]);
	await editProviderTransport(ui, store, "cpa", ["openai-responses"]);
	assert.deepEqual(store.readAll(), { cpa: { transport: "websocket" } });
	assert.deepEqual(menus[1].items.map((item) => item.value), ["", "auto", "sse", "websocket", "websocket-cached"]);
	assert.ok(notifications[0].message.includes("/reload"));
	assert.ok(menus[2].items[0].label.includes("websocket"));
});

test("Escape is not the same as inheriting and does not create config", async (t) => {
	const { store, ui, notifications } = fixture(t, ["transport", null, null]);
	await editProviderTransport(ui, store, "cpa", ["openai-responses"]);
	assert.equal(existsSync(store.path), false);
	assert.equal(notifications.length, 0);
});

test("zero timeout persists; decimal/negative/overflow are rejected; blank clears", async (t) => {
	const { store, ui, notifications } = fixture(t,
		["websocketConnectTimeoutMs", "httpIdleTimeoutMs", "httpIdleTimeoutMs", "httpIdleTimeoutMs", "httpIdleTimeoutMs", "websocketConnectTimeoutMs", null],
		["0", "-1", "1.5", "2147483648", "35000", ""]);
	await editProviderTransport(ui, store, "cpa", ["openai-responses"]);
	assert.deepEqual(store.readProvider("cpa"), { httpIdleTimeoutMs: 35000 });
	assert.equal(notifications.filter((n) => n.type === "error").length, 3);
});

test("inherit clears transport without losing timeout overrides", async (t) => {
	const { store, ui } = fixture(t, ["transport", "", null]);
	store.updateProvider("cpa", (p) => { p.transport = "websocket"; p.httpIdleTimeoutMs = 0; });
	await editProviderTransport(ui, store, "cpa", ["openai-responses"]);
	assert.deepEqual(store.readProvider("cpa"), { httpIdleTimeoutMs: 0 });
});

test("native APIs cannot acquire overrides but existing settings can be cleared", async (t) => {
	const { store, ui, notifications } = fixture(t, ["transport", "sse", "httpIdleTimeoutMs", "transport", "", "httpIdleTimeoutMs", null], ["1000", ""]);
	store.updateProvider("anthropic", (p) => { p.transport = "sse"; p.httpIdleTimeoutMs = 100; });
	await editProviderTransport(ui, store, "anthropic", ["anthropic-messages"]);
	assert.deepEqual(store.readProvider("anthropic"), {});
	assert.equal(notifications.filter((notice) => notice.type === "error").length, 2);
});

test("unsupported model APIs are visible before editing", async (t) => {
	const { store, ui, menus } = fixture(t, [null]);
	await editProviderTransport(ui, store, "mixed", ["openai-responses", "anthropic-messages"]);
	assert.ok(menus[0].items[0].description?.includes("anthropic-messages"));
});
