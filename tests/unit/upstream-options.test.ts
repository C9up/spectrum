import { describe, expect, it } from "vitest";
import { stdSerializers, stdTimeFunctions } from "../../src/index.js";
import { jsonLine } from "../../src/jsonLine.js";
import { Logger } from "../../src/Logger.js";
import { LoggerManager } from "../../src/LoggerManager.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

class Capture implements LogChannel {
	readonly name = "capture";
	readonly entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

function first(capture: Capture): LogEntry {
	const [entry] = capture.entries;
	if (entry === undefined) throw new Error("nothing logged");
	return entry;
}

describe("spectrum > child(bindings, options)", () => {
	it("gives the child its own level", () => {
		const capture = new Capture();
		const parent = new Logger({ level: "info", channels: [capture] });
		const child = parent.child({ scope: "c" }, { level: "error" });
		child.warn("dropped");
		parent.warn("kept");
		expect(child.level).toBe("error");
		expect(capture.entries.map((entry) => entry.message)).toEqual(["kept"]);
	});

	it("replaces redaction, adds serializers and prefixes messages for the child only", () => {
		const capture = new Capture();
		const parent = new Logger({
			level: "info",
			channels: [capture],
			redact: ["password"],
			msgPrefix: "[app] ",
		});
		const child = parent.child(
			{},
			{
				redact: ["token"],
				serializers: { user: (value) => `user:${String(value)}` },
				msgPrefix: "[db] ",
			},
		);
		child.info({ password: "p", token: "t", user: 7 }, "child line");
		parent.info({ password: "p", token: "t", user: 7 }, "parent line");
		const [childEntry, parentEntry] = capture.entries;
		expect(childEntry).toMatchObject({
			message: "[app] [db] child line",
			password: "p",
			token: "[Redacted]",
			user: "user:7",
		});
		expect(parentEntry).toMatchObject({
			message: "[app] parent line",
			password: "[Redacted]",
			token: "t",
			user: 7,
		});
	});

	it("calls onChild with every child", () => {
		const seen: unknown[] = [];
		const parent = new Logger({ level: "info", onChild: (c) => seen.push(c) });
		const child = parent.child({ a: 1 });
		expect(seen).toEqual([child]);
	});
});

describe("spectrum > redact remove and censor function", () => {
	it("removes matched keys with remove: true", () => {
		const capture = new Capture();
		new Logger({
			level: "info",
			channels: [capture],
			redact: { paths: ["user.password", "*.token"], remove: true },
		}).info({ user: { name: "n", password: "p" }, api: { token: "t" } }, "x");
		const entry = first(capture);
		expect(entry.user).toEqual({ name: "n" });
		expect(entry.api).toEqual({});
	});

	it("calls a censor function with the value and the resolved path", () => {
		const calls: Array<[unknown, string[]]> = [];
		const capture = new Capture();
		new Logger({
			level: "info",
			channels: [capture],
			redact: {
				paths: ["users[*].card"],
				censor: (value, path) => {
					calls.push([value, path]);
					return `****${String(value).slice(-4)}`;
				},
			},
		}).info({
			users: [{ card: "4111111111111111" }, { card: "5500000000000004" }],
		});
		expect(first(capture).users).toEqual([
			{ card: "****1111" },
			{ card: "****0004" },
		]);
		expect(calls.map(([, path]) => path)).toEqual([
			["users", "0", "card"],
			["users", "1", "card"],
		]);
	});
});

describe("spectrum > mixin, hooks, errorKey, msgPrefix", () => {
	it("adds the mixin's fields, the merging object winning", () => {
		const capture = new Capture();
		new Logger({
			level: "info",
			channels: [capture],
			mixin: (_object, level) => ({
				requestId: "r-1",
				level30: level,
				a: "mixin",
			}),
		}).info({ a: "call" }, "m");
		expect(first(capture)).toMatchObject({
			requestId: "r-1",
			level30: 30,
			a: "call",
		});
	});

	it("honours mixinMergeStrategy", () => {
		const capture = new Capture();
		new Logger({
			level: "info",
			channels: [capture],
			mixin: () => ({ a: "mixin" }),
			mixinMergeStrategy: (object, mixed) => ({ ...object, ...mixed }),
		}).info({ a: "call" }, "m");
		expect(first(capture).a).toBe("mixin");
	});

	it("routes every call through hooks.logMethod", () => {
		const capture = new Capture();
		new Logger({
			level: "info",
			channels: [capture],
			hooks: {
				logMethod(args, method, level) {
					method(`[${level}] ${String(args[0])}`, ...args.slice(1));
				},
			},
		}).warn("hooked %s", "call");
		expect(first(capture).message).toBe("[40] hooked call");
	});

	it("writes an Error under errorKey and serializes it", () => {
		const capture = new Capture();
		new Logger({ level: "info", channels: [capture], errorKey: "error" }).error(
			new Error("boom"),
		);
		expect(first(capture)).toMatchObject({
			message: "boom",
			error: { type: "Error", message: "boom" },
		});
	});

	it("takes the message of an error in a merging object with none", () => {
		const capture = new Capture();
		new Logger({ level: "info", channels: [capture] }).error({
			err: new Error("from err"),
		});
		expect(first(capture).message).toBe("from err");
	});
});

describe("spectrum > destination and the single transport form", () => {
	it("writes JSON lines to a destination with write()", () => {
		const lines: string[] = [];
		new Logger({
			level: "info",
			destination: { write: (line: string) => lines.push(line) },
		}).info("to a stream");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			level: 30,
			msg: "to a stream",
		});
	});

	it("accepts transport: { target, options }", () => {
		const capture = new Capture();
		new Logger({
			level: "info",
			transport: { target: capture, level: "warn" },
		}).warn("single target");
		expect(first(capture).message).toBe("single target");
	});

	it("refuses options it cannot honour", () => {
		const unsupported = expect.objectContaining({
			code: "E_SPECTRUM_UNSUPPORTED_OPTION",
		});
		for (const option of [
			{ customLevels: { audit: 35 } },
			{ useOnlyCustomLevels: true },
			{ nestedKey: "payload" },
			{ hooks: { streamWrite: (line: string) => line } },
		]) {
			expect(() => Reflect.construct(Logger, [option])).toThrow(unsupported);
		}
		expect(() =>
			Reflect.construct(Logger, [{ transport: { pipeline: [] } }]),
		).toThrow(
			expect.objectContaining({ code: "E_SPECTRUM_UNSUPPORTED_TARGET" }),
		);
		expect(() => Reflect.construct(Logger, [{ destination: true }])).toThrow(
			expect.objectContaining({ code: "E_SPECTRUM_UNSUPPORTED_TARGET" }),
		);
	});
});

describe("spectrum > stdSerializers and stdTimeFunctions", () => {
	it("serializes a request and a response in upstream's shape", () => {
		const req = {
			id: "req-1",
			method: "GET",
			url: "/orders?x=1",
			headers: { host: "example.com" },
			socket: { remoteAddress: "10.0.0.1", remotePort: 5050 },
		};
		expect(stdSerializers.req(req)).toEqual({
			id: "req-1",
			method: "GET",
			url: "/orders?x=1",
			headers: { host: "example.com" },
			remoteAddress: "10.0.0.1",
			remotePort: 5050,
		});
		const res = {
			statusCode: 201,
			headersSent: true,
			getHeaders: () => ({ "content-type": "text/plain" }),
		};
		expect(stdSerializers.res(res)).toEqual({
			statusCode: 201,
			headers: { "content-type": "text/plain" },
		});
		expect(stdSerializers.err(new Error("e"))).toMatchObject({ message: "e" });
	});

	it("time functions plug into timestamp", () => {
		const capture: string[] = [];
		new Logger({
			level: "info",
			timestamp: stdTimeFunctions.isoTime,
			destination: { write: (line: string) => capture.push(line) },
		}).info("iso");
		expect(JSON.parse(capture[0] ?? "").time).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(stdTimeFunctions.nullTime()).toBe("");
		expect(
			jsonLine({ timestamp: "t", level: "info", module: "m", message: "x" }),
		).toContain('"msg":"x"');
	});
});

describe("spectrum > LoggerManager.createLogger", () => {
	it("names the logger after its key and does not cache it", () => {
		const manager = new LoggerManager({
			default: "app",
			loggers: { app: { level: "info" } },
		});
		const a = manager.createLogger("audit", { level: "info" });
		const b = manager.createLogger("audit", { level: "info" });
		expect(a).not.toBe(b);
		expect(a.bindings()).toMatchObject({ name: "audit" });
		expect(manager.use("app")).toBe(manager.use("app"));
	});
});
