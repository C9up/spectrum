import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleChannel } from "../../src/channels/ConsoleChannel.js";
import { FileChannel } from "../../src/channels/FileChannel.js";
import { Logger } from "../../src/Logger.js";
import { stringifyRecord } from "../../src/stringify.js";

function parseObject(line: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(line);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`not a JSON object: ${line}`);
	}
	return Object.fromEntries(Object.entries(parsed));
}

function field(record: Record<string, unknown>, key: string): unknown {
	return record[key];
}

interface Circular {
	a: number;
	self?: Circular;
}

function circular(): Circular {
	const value: Circular = { a: 1 };
	value.self = value;
	return value;
}

function nest(depth: number): Record<string, unknown> {
	let inner: Record<string, unknown> = { leaf: true };
	for (let i = 0; i < depth; i++) inner = { x: inner };
	return inner;
}

describe("spectrum > lines survive payloads JSON.stringify rejects", () => {
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		stdout = [];
		stderr = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				stdout.push(String(chunk));
				return true;
			},
		);
		vi.spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				stderr.push(String(chunk));
				return true;
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function jsonLogger(): Logger {
		return new Logger({
			level: "trace",
			channels: [new ConsoleChannel("json")],
		});
	}

	function onlyLine(): Record<string, unknown> {
		expect(stderr).toEqual([]);
		expect(stdout).toHaveLength(1);
		return parseObject(stdout[0] ?? "");
	}

	it("writes a circular merging object as one line, the cycle as [Circular]", () => {
		jsonLogger().info(
			{ user: circular(), requestId: "r1" },
			"circular payload",
		);
		const line = onlyLine();
		expect(field(line, "msg")).toBe("circular payload");
		expect(field(line, "requestId")).toBe("r1");
		expect(field(line, "user")).toEqual({ a: 1, self: "[Circular]" });
	});

	it("keeps a circular child binding", () => {
		jsonLogger().child({ ctx: circular() }).warn("from a child");
		const line = onlyLine();
		expect(field(line, "level")).toBe(40);
		expect(field(line, "ctx")).toEqual({ a: 1, self: "[Circular]" });
	});

	it("writes a BigInt as a number", () => {
		jsonLogger().info(
			{ amount: 12345678901234567890n, ok: 1 },
			"bigint payload",
		);
		expect(stdout[0]).toContain('"amount":12345678901234567890');
		expect(field(onlyLine(), "ok")).toBe(1);
	});

	it("bounds depth and breadth once the fallback is in use", () => {
		const payload = {
			deep: nest(10),
			list: Array.from({ length: 1000 }, (_, i) => i),
			n: 1n,
		};
		jsonLogger().info({ payload }, "bounded");
		const written = field(onlyLine(), "payload");
		expect(JSON.stringify(written)).toContain('"[Object]"');
		const list = parseObject(JSON.stringify(written)).list;
		expect(Array.isArray(list) ? list.length : 0).toBe(101);
		expect(JSON.stringify(list)).toContain("... 900 items not stringified");
	});

	it("writes a payload JSON accepts exactly as JSON writes it", () => {
		const list = Array.from({ length: 1000 }, (_, i) => i);
		jsonLogger().info({ list, deep: nest(10) }, "plain");
		const line = onlyLine();
		expect(field(line, "list")).toEqual(list);
		expect(field(line, "deep")).toEqual(nest(10));
	});

	it("honours depthLimit / edgeLimit from the logger config", () => {
		const logger = new Logger({
			level: "info",
			depthLimit: 2,
			edgeLimit: 3,
			channels: [new ConsoleChannel("json")],
		});
		logger.info(
			{ payload: { a: { b: { c: 1 } }, list: [1, 2, 3, 4, 5], n: 1n } },
			"limits",
		);
		expect(field(onlyLine(), "payload")).toEqual({
			a: { b: "[Object]" },
			list: [1, 2, 3, "... 2 items not stringified"],
			n: 1,
		});
	});

	it("rejects a depthLimit or edgeLimit that is not a positive integer", () => {
		for (const bad of [0, -1, 1.5, Number.NaN]) {
			expect(() => new Logger({ depthLimit: bad })).toThrow(
				expect.objectContaining({
					code: "E_SPECTRUM_INVALID_STRINGIFY_LIMIT",
					message: expect.stringMatching(/depthLimit/),
				}),
			);
			expect(() => new Logger({ edgeLimit: bad })).toThrow(/edgeLimit/);
		}
	});

	it("writes the pretty data part of a circular payload", () => {
		new Logger({
			level: "info",
			channels: [new ConsoleChannel("pretty")],
		}).info({ user: circular(), n: 2n }, "pretty circular");
		expect(stderr).toEqual([]);
		expect(stdout).toHaveLength(1);
		expect(stdout[0]).toContain("pretty circular");
		expect(stdout[0]).toContain('"self":"[Circular]"');
		expect(stdout[0]).toContain('"n":2');
	});

	it("writes a field whose toJSON throws as a notice, keeping the others", () => {
		const hostile = {
			toJSON(): never {
				throw new Error("no");
			},
		};
		jsonLogger().info({ hostile, kept: "yes" }, "hostile");
		const line = onlyLine();
		expect(field(line, "kept")).toBe("yes");
		expect(String(field(line, "hostile"))).toMatch(/unable to serialize/);
	});
});

describe("spectrum > FileChannel survives payloads JSON.stringify rejects", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-safe-"));
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("writes circular and BigInt payloads as parseable lines", async () => {
		const file = path.join(dir, "app.log");
		const channel = new FileChannel({ path: file });
		const logger = new Logger({ level: "info", channels: [channel] });
		logger.info({ user: circular() }, "circular");
		logger.info({ n: 3n }, "bigint");
		await channel.close();
		const lines = (await fsp.readFile(file, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(2);
		const [first, second] = lines.map(parseObject);
		expect(first && field(first, "user")).toEqual({ a: 1, self: "[Circular]" });
		expect(second && field(second, "n")).toBe(3);
	});
});

describe("spectrum > stringifyRecord", () => {
	it("cuts a cycle only on the path, not a value shared by two branches", () => {
		const shared = { v: 1 };
		const record: Record<string, unknown> = {
			left: shared,
			right: shared,
			n: 1n,
		};
		expect(parseObject(stringifyRecord(record))).toEqual({
			left: { v: 1 },
			right: { v: 1 },
			n: 1,
		});
	});
});
