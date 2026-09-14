import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync, existsSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransportConfigStore, TRANSPORTS, validateTransportSettings } from "../src/transport-config.ts";

function fixture(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-transport-test-"));
	t.after(() => { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
	const path = join(dir, "provider-transports.json");
	return { dir, path, store: new TransportConfigStore(path) };
}

test("defaults are read-only and clearing an absent provider creates nothing", (t) => {
	const { store, path } = fixture(t);
	assert.deepEqual(store.readAll(), {});
	assert.deepEqual(store.readProvider("cpa"), {});
	store.updateProvider("cpa", (p) => { delete p.transport; });
	assert.equal(existsSync(path), false);
});

test("each transport persists and only the target provider changes", (t) => {
	const { store, path } = fixture(t);
	writeFileSync(path, '{"custom":"keep","providers":{"other":{"transport":"sse"}}}');
	for (const transport of TRANSPORTS) {
		store.updateProvider("cpa", (p) => { p.transport = transport; p.websocketConnectTimeoutMs = 0; });
		assert.deepEqual(store.readProvider("cpa"), { transport, websocketConnectTimeoutMs: 0 });
		assert.deepEqual(store.readProvider("other"), { transport: "sse" });
	}
	assert.equal(JSON.parse(readFileSync(path, "utf8")).custom, "keep");
	store.updateProvider("cpa", (p) => { delete p.transport; delete p.websocketConnectTimeoutMs; });
	assert.deepEqual(store.readProvider("cpa"), {});
	assert.deepEqual(store.readAll(), { other: { transport: "sse" } });
});

test("JSONC comments, BOM, CRLF, unknown fields and permissions survive", (t) => {
	const { store, path, dir } = fixture(t);
	writeFileSync(path, '\uFEFF{\r\n  // keep comment\r\n  "providers": {"cpa": {"extra": "preserved", "transport": "auto"}}\r\n}\r\n', { mode: 0o600 });
	store.updateProvider("cpa", (p) => { p.transport = "websocket"; });
	const raw = readFileSync(path, "utf8");
	assert.ok(raw.startsWith("\uFEFF"));
	assert.ok(raw.includes("// keep comment"));
	assert.ok(raw.includes('"extra": "preserved"'));
	assert.ok(!raw.replaceAll("\r\n", "").includes("\n"));
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(dir), ["provider-transports.json"]);
});

test("new settings are private and symlink targets are updated in place", (t) => {
	const { store, path, dir } = fixture(t);
	store.updateProvider("cpa", (p) => { p.transport = "websocket"; });
	assert.equal(statSync(path).mode & 0o777, 0o600);
	const link = join(dir, "link.json");
	symlinkSync(path, link);
	new TransportConfigStore(link).updateProvider("cpa", (p) => { p.httpIdleTimeoutMs = 200; });
	assert.equal(store.readProvider("cpa").httpIdleTimeoutMs, 200);
});

test("invalid settings and malformed files fail without overwriting", (t) => {
	for (const value of [null, [], { transport: "ws" }, { transport: false }, { httpIdleTimeoutMs: -1 }, { websocketConnectTimeoutMs: 0.5 }, { httpIdleTimeoutMs: Infinity }, { httpIdleTimeoutMs: 2 ** 31 }]) {
		assert.throws(() => validateTransportSettings(value));
	}
	const { store, path } = fixture(t);
	for (const raw of ['{bad', '[]', '{"providers":[]}', '{"providers":{"cpa":{"transport":"invalid"}}}']) {
		writeFileSync(path, raw);
		assert.throws(() => store.updateProvider("cpa", (p) => { p.transport = "websocket"; }));
		assert.equal(readFileSync(path, "utf8"), raw);
	}
});

test("provider ids do not resolve prototype properties", (t) => {
	const { store } = fixture(t);
	assert.deepEqual(store.readProvider("constructor"), {});
	assert.throws(() => store.updateProvider("__proto__", (p) => { p.transport = "sse"; }), /id 不合法/);
	assert.deepEqual(store.readProvider("__proto__"), {});
	assert.equal(({} as { transport?: string }).transport, undefined);
});

test("conflicting external edits are not overwritten and temp files are removed", (t) => {
	const { store, path, dir } = fixture(t);
	store.updateProvider("cpa", (p) => { p.transport = "sse"; });
	const external = '{"providers":{"other":{"transport":"auto"}}}';
	assert.throws(() => store.updateProvider("cpa", (p) => {
		p.transport = "websocket";
		writeFileSync(path, external);
	}), /其他进程/);
	assert.equal(readFileSync(path, "utf8"), external);
	assert.deepEqual(readdirSync(dir), ["provider-transports.json"]);
});
