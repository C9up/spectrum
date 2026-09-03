import { beforeEach, describe, expect, it } from "vitest";
import type { LogChannel, LogEntry } from "../../src/index.js";
import {
	ConsoleChannel,
	createRustLogBridge,
	Logger,
	parseRustLog,
} from "../../src/index.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

/** In-memory channel for testing. */
class TestChannel implements LogChannel {
	name = "test";
	entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

describe("logger > log levels", () => {
	let channel: TestChannel;
	let logger: Logger;

	beforeEach(() => {
		channel = new TestChannel();
		logger = new Logger({ level: "info", channels: [channel] });
	});

	it("logs at info level and above", () => {
		logger.trace("should not appear");
		logger.debug("should not appear");
		logger.info("visible");
		logger.warn("visible");
		logger.error("visible");
		logger.fatal("visible");

		expect(channel.entries.length).toBe(4);
		expect(channel.entries.map((e) => e.level)).toEqual([
			"info",
			"warn",
			"error",
			"fatal",
		]);
	});

	it("logs at trace level when configured", () => {
		const traceLogger = new Logger({ level: "trace", channels: [channel] });
		traceLogger.trace("visible");
		traceLogger.debug("visible");
		expect(channel.entries.length).toBe(2);
	});

	it("includes message and module", () => {
		logger.info("test message");
		expect(defined(channel.entries[0]).message).toBe("test message");
		expect(defined(channel.entries[0]).module).toBe("app");
	});

	it("includes timestamp as ISO 8601", () => {
		logger.info("test");
		expect(defined(channel.entries[0]).timestamp).toMatch(
			/^\d{4}-\d{2}-\d{2}T/,
		);
	});

	it("merges a message-first data object at the entry root (pino parity)", () => {
		logger.info("order", { orderId: "123", amount: 42 });
		expect(defined(channel.entries[0]).orderId).toBe("123");
		expect(defined(channel.entries[0]).amount).toBe(42);
		// The message-first structured form does not nest under `data`.
		expect(defined(channel.entries[0]).data).toBeUndefined();
	});
});

describe("logger > correlation ID", () => {
	it("carries correlation ID when set", () => {
		const channel = new TestChannel();
		const logger = new Logger({ level: "info", channels: [channel] });
		logger.setCorrelationId("corr-abc");

		logger.info("test");
		expect(defined(channel.entries[0]).correlationId).toBe("corr-abc");
	});

	it("child logger inherits correlation ID", () => {
		const channel = new TestChannel();
		const logger = new Logger({ level: "info", channels: [channel] });
		logger.setCorrelationId("parent-id");

		const child = logger.child({ module: "OrderService" });
		child.info("child log");

		expect(defined(channel.entries[0]).module).toBe("OrderService");
		expect(defined(channel.entries[0]).correlationId).toBe("parent-id");
	});

	it("child logger can override correlation ID", () => {
		const channel = new TestChannel();
		const logger = new Logger({ level: "info", channels: [channel] });

		const child = logger.child({ module: "test", correlationId: "child-id" });
		child.info("test");

		expect(defined(channel.entries[0]).correlationId).toBe("child-id");
	});
});

describe("logger > per-module level override", () => {
	it("respects module-specific log level", () => {
		const channel = new TestChannel();
		const logger = new Logger({
			level: "info",
			channels: [channel],
			modules: { "bus:rust": "warn" }, // Only warn+ for bus:rust
		});

		const busLogger = logger.child({ module: "bus:rust" });
		busLogger.info("should not appear");
		busLogger.warn("should appear");

		expect(channel.entries.length).toBe(1);
		expect(defined(channel.entries[0]).level).toBe("warn");
	});
});

describe("logger > multiple channels", () => {
	it("writes to all channels", () => {
		const ch1 = new TestChannel();
		const ch2 = new TestChannel();
		const logger = new Logger({ level: "info", channels: [ch1, ch2] });

		logger.info("test");

		expect(ch1.entries.length).toBe(1);
		expect(ch2.entries.length).toBe(1);
	});
});

describe("logger > ConsoleChannel", () => {
	it("creates without error", () => {
		const channel = new ConsoleChannel("json");
		expect(channel.name).toBe("console");
	});

	it("pretty format creates without error", () => {
		const channel = new ConsoleChannel("pretty");
		expect(channel.name).toBe("console");
	});
});

describe("logger > RustLogBridge", () => {
	it("parses standard Rust log format", () => {
		const entry = parseRustLog("[INFO ream_http] Server listening");
		expect(entry).not.toBeNull();
		expect(entry?.level).toBe("info");
		expect(entry?.module).toBe("ream-http");
		expect(entry?.message).toBe("Server listening");
	});

	it("prevents recursive stderr interception when channels write to stderr", () => {
		const originalWrite = process.stderr.write;
		const passthrough: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			passthrough.push(
				typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
			);
			return true;
		}) as typeof process.stderr.write;

		try {
			let writes = 0;
			const channel: LogChannel = {
				name: "recursive-test",
				write() {
					writes += 1;
					// This would recurse without guard in RustLogBridge.
					process.stderr.write("[ERROR ream_bus] echoed by channel\n");
				},
			};

			const bridge = createRustLogBridge([channel]);
			bridge.start();
			process.stderr.write("[ERROR ream_http] root error\n");
			bridge.stop();

			expect(writes).toBe(1);
			expect(passthrough.length).toBeGreaterThan(0);
		} finally {
			process.stderr.write = originalWrite;
		}
	});
});

describe("logger > channel-failure fallback sanitization", () => {
	it("escapes CR/LF in the channel name, message, and error (no log-forging)", () => {
		const originalWrite = process.stderr.write;
		const captured: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			captured.push(
				typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
			);
			return true;
		}) as typeof process.stderr.write;

		try {
			const channel: LogChannel = {
				name: "evil\ninjected",
				write() {
					throw new Error("boom\nforged");
				},
			};
			const logger = new Logger({ level: "info", channels: [channel] });
			logger.info("msg\nwith-newline");

			const out = captured.join("");
			expect(out).toContain("evil\\ninjected"); // channel name escaped
			expect(out).toContain("msg\\nwith-newline"); // message escaped
			expect(out).toContain("boom\\nforged"); // error escaped
			// Only the trailing line terminator is a real newline — nothing inside
			// the payload forged another line.
			expect(out.replace(/\n$/, "")).not.toContain("\n");
		} finally {
			process.stderr.write = originalWrite;
		}
	});
});
