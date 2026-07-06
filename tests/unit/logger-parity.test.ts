import { beforeEach, describe, expect, it } from "vitest";
import type { LogChannel, LogEntry } from "../../src/index.js";
import { defineConfig, Logger, LoggerManager } from "../../src/index.js";

class TestChannel implements LogChannel {
	name = "test";
	entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

describe("logger > object-first / merging object (gap 4)", () => {
	let channel: TestChannel;
	let logger: Logger;

	beforeEach(() => {
		channel = new TestChannel();
		logger = new Logger({ level: "info", channels: [channel] });
	});

	it("merges an object-first merging object at the root", () => {
		logger.info({ userId: 5, role: "admin" }, "logged in");
		const e = channel.entries[0];
		expect(e.message).toBe("logged in");
		expect(e.userId).toBe(5);
		expect(e.role).toBe("admin");
	});

	it("interpolates printf tokens via util.format", () => {
		logger.info("user %s did %d actions", "bob", 3);
		expect(channel.entries[0].message).toBe("user bob did 3 actions");
	});

	it("interpolates %o object tokens instead of merging", () => {
		logger.info("payload %o", { a: 1 });
		expect(channel.entries[0].message).toContain("a: 1");
		expect(channel.entries[0].a).toBeUndefined();
	});

	it("a bare Error becomes an `err` field serialized to name/message/stack", () => {
		logger.error(new Error("boom"));
		const err = channel.entries[0].err as { name: string; message: string };
		expect(err.name).toBe("Error");
		expect(err.message).toBe("boom");
		expect(channel.entries[0].message).toBe("boom");
	});

	it("structural fields cannot be overwritten by the merging object", () => {
		logger.info({ level: "trace", module: "evil" }, "safe");
		expect(channel.entries[0].level).toBe("info");
		expect(channel.entries[0].module).toBe("app");
	});
});

describe("logger > enabled flag (gap 3)", () => {
	it("no-ops every log call and reports isEnabled=false when disabled", () => {
		const channel = new TestChannel();
		const logger = new Logger({
			enabled: false,
			level: "info",
			channels: [channel],
		});
		expect(logger.isEnabled).toBe(false);
		logger.info("nope");
		logger.error("also nope");
		expect(channel.entries).toHaveLength(0);
	});

	it("child() returns the same instance when disabled", () => {
		const logger = new Logger({ enabled: false, channels: [] });
		expect(logger.child({ module: "x" })).toBe(logger);
	});
});

describe("logger > level API (gap 5)", () => {
	it("get/set level", () => {
		const logger = new Logger({ level: "info", channels: [] });
		expect(logger.level).toBe("info");
		logger.level = "debug";
		expect(logger.level).toBe("debug");
	});

	it("isLevelEnabled reflects the threshold", () => {
		const logger = new Logger({ level: "warn", channels: [] });
		expect(logger.isLevelEnabled("info")).toBe(false);
		expect(logger.isLevelEnabled("error")).toBe(true);
	});

	it("ifLevelEnabled only runs the callback when enabled", () => {
		const logger = new Logger({ level: "warn", channels: [] });
		let ran = 0;
		logger.ifLevelEnabled("info", () => ran++);
		logger.ifLevelEnabled("error", () => ran++);
		expect(ran).toBe(1);
	});

	it("levelNumber and levels expose the mapping", () => {
		const logger = new Logger({ level: "warn", channels: [] });
		expect(logger.levelNumber).toBe(3);
		expect(logger.levels.values.warn).toBe(3);
		expect(logger.levels.labels[3]).toBe("warn");
	});
});

describe("logger > public log() (gap 6)", () => {
	it("logs at a named level with a merging object", () => {
		const channel = new TestChannel();
		const logger = new Logger({ level: "trace", channels: [channel] });
		logger.log("debug", { a: 1 }, "hi");
		expect(channel.entries[0].level).toBe("debug");
		expect(channel.entries[0].a).toBe(1);
		expect(channel.entries[0].message).toBe("hi");
	});
});

describe("logger > redact (gap 7)", () => {
	it("censors top-level paths with the default censor", () => {
		const channel = new TestChannel();
		const logger = new Logger({
			level: "info",
			channels: [channel],
			redact: ["password", "authorization"],
		});
		logger.info(
			{ password: "hunter2", authorization: "Bearer x", ok: 1 },
			"login",
		);
		const e = channel.entries[0];
		expect(e.password).toBe("[Redacted]");
		expect(e.authorization).toBe("[Redacted]");
		expect(e.ok).toBe(1);
	});

	it("censors nested dot-paths with a custom censor and no mutation of the input", () => {
		const channel = new TestChannel();
		const logger = new Logger({
			level: "info",
			channels: [channel],
			redact: { paths: ["req.headers.authorization"], censor: "***" },
		});
		const input = { req: { headers: { authorization: "secret", host: "x" } } };
		logger.info(input, "req");
		const req = channel.entries[0].req as {
			headers: { authorization: string; host: string };
		};
		expect(req.headers.authorization).toBe("***");
		expect(req.headers.host).toBe("x");
		// Caller's object must be untouched (copy-on-write).
		expect(input.req.headers.authorization).toBe("secret");
	});
});

describe("logger > serializers (gap 8)", () => {
	it("applies default err serializer", () => {
		const channel = new TestChannel();
		const logger = new Logger({ level: "info", channels: [channel] });
		logger.info({ err: new Error("bad") }, "failed");
		const err = channel.entries[0].err as { message: string; stack: string };
		expect(err.message).toBe("bad");
		expect(typeof err.stack).toBe("string");
	});

	it("applies a configured custom serializer", () => {
		const channel = new TestChannel();
		const logger = new Logger({
			level: "info",
			channels: [channel],
			serializers: { user: (v) => `user:${(v as { id: number }).id}` },
		});
		logger.info({ user: { id: 7 } }, "hi");
		expect(channel.entries[0].user).toBe("user:7");
	});
});

describe("logger > silent level (gap 9)", () => {
	it("emits nothing when level is silent", () => {
		const channel = new TestChannel();
		const logger = new Logger({ level: "silent", channels: [channel] });
		logger.fatal("should not appear");
		expect(channel.entries).toHaveLength(0);
		expect(logger.levelNumber).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("logger > child bindings + bindings() (gaps 10, 11)", () => {
	it("merges arbitrary child bindings into every entry", () => {
		const channel = new TestChannel();
		const logger = new Logger({ level: "info", channels: [channel] });
		const child = logger.child({ requestId: "r-1", tenant: "acme" });
		child.info("hit");
		expect(channel.entries[0].requestId).toBe("r-1");
		expect(channel.entries[0].tenant).toBe("acme");
	});

	it("keeps module/correlationId as conventions and exposes bindings()", () => {
		const logger = new Logger({ level: "info", channels: [] });
		const child = logger.child({
			module: "svc",
			correlationId: "c-9",
			extra: true,
		});
		expect(child.bindings()).toEqual({
			module: "svc",
			correlationId: "c-9",
			extra: true,
		});
	});
});

describe("defineConfig + LoggerManager (gaps 1, 2)", () => {
	it("wraps the legacy flat form under an `app` logger", () => {
		const channel = new TestChannel();
		const config = defineConfig({ level: "info", channels: [channel] });
		expect(config.default).toBe("app");
		expect(config.loggers.app.level).toBe("info");
	});

	it("returns the multi-logger form untouched and validates it", () => {
		const config = defineConfig({
			default: "main",
			loggers: { main: { level: "debug", channels: [] } },
		});
		expect(config.default).toBe("main");
		expect(config.loggers.main.level).toBe("debug");
	});

	it("throws when the default logger is missing", () => {
		expect(() =>
			defineConfig({ default: "nope", loggers: { main: { channels: [] } } }),
		).toThrow(/loggers\.nope/);
	});

	it("manager.use() returns cached per-name loggers and is itself a Logger", () => {
		const a = new TestChannel();
		const b = new TestChannel();
		const manager = new LoggerManager({
			default: "app",
			loggers: {
				app: { level: "info", channels: [a] },
				audit: { level: "info", channels: [b] },
			},
		});
		expect(manager).toBeInstanceOf(Logger);
		const audit = manager.use("audit");
		expect(manager.use("audit")).toBe(audit);
		audit.info("audited");
		manager.info("default");
		expect(b.entries).toHaveLength(1);
		expect(a.entries).toHaveLength(1);
	});

	it("manager.create() builds an unmanaged logger", () => {
		const manager = new LoggerManager({
			default: "app",
			loggers: { app: { channels: [] } },
		});
		const adhoc = manager.create({ level: "trace", channels: [] });
		expect(adhoc).toBeInstanceOf(Logger);
	});
});
