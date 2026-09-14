import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";

function frame(event: unknown): Buffer {
	const data = Buffer.from(JSON.stringify(event));
	if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
	const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2);
	return Buffer.concat([header, data]);
}

test("actual Pi CLI loads the plugin and completes a local Responses turn via WS only", { timeout: 20_000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-host-ws-test-"));
	const sockets = new Set<Socket>();
	let httpRequests = 0;
	let upgrades = 0;
	let wire: Record<string, unknown> | undefined;
	const server = createServer((_req, res) => { httpRequests++; res.writeHead(500); res.end("HTTP not allowed in strict WS test"); });
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	server.on("upgrade", (request, socket) => {
		upgrades++;
		assert.equal(request.url, "/v1/responses");
		assert.equal(request.headers.authorization, "Bearer dummy-host-key");
		const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		let bytes = Buffer.alloc(0);
		socket.on("data", (data: Buffer) => {
			bytes = Buffer.concat([bytes, data]);
			if (bytes.length < 2) return;
			if ((bytes[0] & 15) === 8) { socket.end(Buffer.from([0x88, 0])); return; }
			let size = bytes[1] & 127;
			let offset = 2;
			if (size === 126) { if (bytes.length < 4) return; size = bytes.readUInt16BE(2); offset = 4; }
			if (size === 127) { if (bytes.length < 10) return; size = Number(bytes.readBigUInt64BE(2)); offset = 10; }
			assert.ok(size < 1_000_000);
			if (bytes.length < offset + 4 + size) return;
			const mask = bytes.subarray(offset, offset + 4);
			const payload = Buffer.from(bytes.subarray(offset + 4, offset + 4 + size));
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
			bytes = bytes.subarray(offset + 4 + size);
			wire = JSON.parse(payload.toString());
			const item = { type: "message", id: "msg_host", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] };
			socket.write(Buffer.concat([
				frame({ type: "codex.rate_limits", rate_limits: {}, plan_type: "dummy" }),
				frame({ type: "codex.response.metadata", metadata: {} }),
				frame({ type: "response.created", response: { id: "resp_host", status: "in_progress" } }),
				frame({ type: "response.output_item.added", output_index: 0, item }),
				frame({ type: "response.output_item.done", output_index: 0, item }),
				frame({ type: "responsesapi.websocket_timing", duration_ms: 1 }),
				frame({ type: "response.completed", response: { id: "resp_host", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 1 } } }),
			]));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((done) => server.close(() => done()));
		const removeFixture = (path: string) => {
			for (const entry of readdirSync(path, { withFileTypes: true })) {
				const child = join(path, entry.name);
				if (entry.isDirectory()) removeFixture(child); else unlinkSync(child);
			}
			rmdirSync(path);
		};
		removeFixture(dir);
	});
	const address = server.address(); assert.ok(address && typeof address !== "string");
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { "local-test": { api: "openai-responses", apiKey: "dummy-host-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "dummy", maxTokens: 128 }] } } }));
	writeFileSync(join(dir, "provider-transports.json"), JSON.stringify({ providers: { "local-test": { transport: "websocket", websocketConnectTimeoutMs: 2000, httpIdleTimeoutMs: 2000 } } }));
	const piRoot = process.env.PI_TEST_PACKAGE_DIR ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/agent-manager.ts");
	const child = spawn(process.execPath, [join(piRoot, "dist/bundle/cli.js"), "--no-extensions", "-e", plugin, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--no-session", "--provider", "local-test", "--model", "dummy", "--thinking", "off", "--system-prompt", "Reply OK", "-p", "hello"], {
		cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => { if (child.exitCode === null) child.kill(); });
	let stdout = "", stderr = "";
	child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
	child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
	const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
	assert.equal(code, 0, stderr);
	assert.equal(stdout.trim(), "OK", stderr);
	assert.equal(httpRequests, 0);
	assert.equal(upgrades, 1);
	assert.equal(wire?.type, "response.create");
	assert.equal(wire?.model, "dummy");
	assert.equal(wire?.stream, undefined);
});
