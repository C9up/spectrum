import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { hostname } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleChannel } from "../../src/channels/ConsoleChannel.js";
import { FileChannel } from "../../src/channels/FileChannel.js";
import { jsonLine } from "../../src/jsonLine.js";
import { Logger } from "../../src/Logger.js";
import type { LogConfig } from "../../src/types.js";

function parse(line: string | undefined): Record<string, unknown> {
	const parsed: unknown = JSON.parse(line ?? "");
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`not an object: ${line}`);
	}
	return Object.fromEntries(Object.entries(parsed));
}

describe("spectrum > JSON lines in pino's shape", () => {
	let stdout: string[];

	beforeEach(() => {
		stdout = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				stdout.push(String(chunk));
				return true;
			},
		);
		vi.useFakeTimers({ now: new Date("2026-11-09T17:15:58.732Z") });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function log(config: Partial<LogConfig> = {}): string {
		new Logger({
			level: "info",
			channels: [new ConsoleChannel("json", { stream: "stdout" })],
			...config,
		})
			.child({ correlationId: "req-1" })
			.info({ userId: 7 }, "signed in");
		return stdout.join("");
	}

	it("writes level as a number, time in epoch ms, pid, hostname and msg", () => {
		const out = log();
		expect(out).toMatch(
			/^\{"level":30,"time":1794244558732,"pid":\d+,"hostname":/,
		);
		expect(out.endsWith('"msg":"signed in"}\n')).toBe(true);
		expect(parse(out)).toEqual({
			level: 30,
			time: Date.parse("2026-11-09T17:15:58.732Z"),
			pid: process.pid,
			hostname: hostname(),
			module: "app",
			correlationId: "req-1",
			userId: 7,
			msg: "signed in",
		});
	});

	it("honours messageKey, timestamp and base", () => {
		expect(
			parse(log({ messageKey: "message", timestamp: "iso", base: null })),
		).toEqual({
			level: 30,
			time: "2026-11-09T17:15:58.732Z",
			module: "app",
			correlationId: "req-1",
			userId: 7,
			message: "signed in",
		});
	});

	it("writes unix seconds, no time, or a custom time fragment", () => {
		expect(parse(log({ timestamp: "unix" })).time).toBe(1794244559);
		stdout = [];
		expect(parse(log({ timestamp: false }))).not.toHaveProperty("time");
		stdout = [];
		expect(parse(log({ timestamp: () => ',"time":"custom"' })).time).toBe(
			"custom",
		);
	});

	it("honours formatters.level and formatters.log", () => {
		const line = parse(
			log({
				base: { service: "api" },
				formatters: {
					level: (label) => ({ severity: label.toUpperCase() }),
					log: (object) => ({ ...object, enriched: true }),
				},
			}),
		);
		expect(line.severity).toBe("INFO");
		expect(line).not.toHaveProperty("level");
		expect(line.service).toBe("api");
		expect(line.enriched).toBe(true);
	});

	it("does not let a merged field forge level, time or msg", () => {
		new Logger({
			level: "info",
			channels: [new ConsoleChannel("json", { stream: "stdout" })],
		}).info({ level: 60, time: 0, msg: "forged" }, "real");
		const line = parse(stdout.join(""));
		expect(line.level).toBe(30);
		expect(line.msg).toBe("real");
		expect(line.time).not.toBe(0);
		expect(stdout.join("").match(/"level"/g)).toHaveLength(1);
	});

	it("rejects line options it cannot honour", () => {
		const code = expect.objectContaining({
			code: "E_SPECTRUM_INVALID_LINE_OPTIONS",
		});
		expect(() => new Logger({ messageKey: "" })).toThrow(code);
		expect(() => Reflect.construct(Logger, [{ timestamp: "rfc" }])).toThrow(
			code,
		);
		expect(() => Reflect.construct(Logger, [{ base: "x" }])).toThrow(code);
	});
});

describe("spectrum > FileChannel lines share the shape", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-shape-"));
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("writes level, time, pid, hostname and msg", async () => {
		const file = path.join(dir, "app.log");
		const channel = new FileChannel({ path: file });
		new Logger({ level: "info", channels: [channel], messageKey: "message" })
			.child({ module: "db" })
			.warn({ ms: 12 }, "slow query");
		await channel.close();
		const line = parse((await fsp.readFile(file, "utf8")).trim());
		expect(line).toMatchObject({
			level: 40,
			pid: process.pid,
			hostname: hostname(),
			module: "db",
			ms: 12,
			message: "slow query",
		});
		expect(typeof line.time).toBe("number");
	});
});

describe("spectrum > a hand-built entry with a timestamp that is no date", () => {
	it("still writes valid JSON", () => {
		const line = jsonLine({
			timestamp: "not-a-date",
			level: "info",
			module: "m",
			message: "x",
		});
		expect(parse(line).time).toBe("not-a-date");
	});
});
