import { existsSync, readFileSync, realpathSync, mkdirSync, openSync, writeFileSync, closeSync, renameSync, unlinkSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "comment-json";

export const TRANSPORTS = ["auto", "sse", "websocket", "websocket-cached"] as const;
export type Transport = (typeof TRANSPORTS)[number];
export interface ProviderTransportSettings {
	transport?: Transport;
	websocketConnectTimeoutMs?: number;
	httpIdleTimeoutMs?: number;
}
type Config = { providers?: Record<string, ProviderTransportSettings>; [key: string]: unknown };
const TIMEOUT_KEYS = ["websocketConnectTimeoutMs", "httpIdleTimeoutMs"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject invalid settings rather than silently restoring HTTP transport. */
export function validateTransportSettings(value: unknown): ProviderTransportSettings {
	if (!isRecord(value)) throw new Error("供应商传输设置必须是对象");
	if (value.transport !== undefined && !(TRANSPORTS as readonly unknown[]).includes(value.transport)) {
		throw new Error("transport 必须是 auto / sse / websocket / websocket-cached");
	}
	for (const key of TIMEOUT_KEYS) {
		const n = value[key];
		if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 2_147_483_647)) {
			throw new Error(`${key} 必须是 0 到 2147483647 的整数毫秒值`);
		}
	}
	return Object.fromEntries(["transport", ...TIMEOUT_KEYS]
		.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) as ProviderTransportSettings;
}

/** Extension-owned settings; Pi models.json and credentials remain untouched. */
export class TransportConfigStore {
	readonly path: string;
	constructor(path: string) { this.path = path; }

	private load(): { config: Config; raw: string; path: string } {
		const path = existsSync(this.path) ? realpathSync(this.path) : this.path;
		const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
		let config: unknown;
		try { config = raw ? parse(raw.replace(/^\uFEFF/, "")) : {}; }
		catch { throw new Error(`传输配置无法解析，未修改文件: ${this.path}`); }
		if (!isRecord(config) || (config.providers !== undefined && !isRecord(config.providers))) {
			throw new Error(`传输配置必须包含 providers 对象: ${this.path}`);
		}
		return { config: config as Config, raw, path };
	}

	readEntries(): Record<string, unknown> {
		return this.load().config.providers ?? {};
	}

	readAll(): Record<string, ProviderTransportSettings> {
		const { config } = this.load();
		return Object.fromEntries(Object.entries(config.providers ?? {}).map(([id, value]) => [id, validateTransportSettings(value)]));
	}

	readProvider(id: string): ProviderTransportSettings {
		const { config } = this.load();
		return config.providers && Object.hasOwn(config.providers, id) ? validateTransportSettings(config.providers[id]) : {};
	}

	updateProvider(id: string, update: (settings: ProviderTransportSettings) => void): void {
		if (!id.trim() || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("供应商 id 不合法");
		const { config, raw, path } = this.load();
		config.providers ??= {};
		const entry = Object.hasOwn(config.providers, id) ? config.providers[id] : {};
		validateTransportSettings(entry);
		update(entry);
		validateTransportSettings(entry);
		if (Object.keys(entry).length) {
			Object.defineProperty(config.providers, id, { value: entry, writable: true, configurable: true, enumerable: true });
		} else {
			delete config.providers[id];
		}
		if (!raw && !Object.keys(config.providers).length) return;
		const newline = raw.includes("\r\n") ? "\r\n" : "\n";
		const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
		const next = bom + (stringify(config, null, 2) + "\n").replace(/\r?\n/g, newline);
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.${randomUUID()}.tmp`;
		const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
		const fd = openSync(temp, "wx", mode);
		try {
			try { writeFileSync(fd, next, "utf8"); }
			finally { closeSync(fd); }
			const current = existsSync(path) ? readFileSync(path, "utf8") : "";
			if (current !== raw) throw new Error("传输配置已被其他进程修改，请重试");
			renameSync(temp, path);
		} finally {
			if (existsSync(temp)) unlinkSync(temp);
		}
	}
}
