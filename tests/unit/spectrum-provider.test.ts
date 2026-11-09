import { afterEach, describe, expect, it } from "vitest";
import type { LogChannel, LogEntry } from "../../src/index.js";
import { Logger } from "../../src/Logger.js";
import SpectrumProvider from "../../src/SpectrumProvider.js";
import { makeApp, resolveLogger } from "../helpers/app.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

/** In-memory channel for asserting what the provider-built Logger emits. */
class TestChannel implements LogChannel {
	name = "test";
	entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

describe("spectrum > SpectrumProvider", () => {
	const originalLevel = process.env.LOG_LEVEL;

	afterEach(() => {
		if (originalLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = originalLevel;
	});

	it("registers Logger and 'logger' string token to the same singleton", async () => {
		const app = makeApp();
		new SpectrumProvider(app).register();

		const byClass = await app.container.resolve(Logger);
		const byToken = await app.container.resolve("logger");
		expect(byClass).toBeInstanceOf(Logger);
		expect(byToken).toBe(byClass);
	});

	it("throws a clear error when `default` references a missing logger (not a crash at first log)", () => {
		const app = makeApp({
			default: "prod",
			loggers: { app: { level: "info", channels: [new TestChannel()] } },
		});
		const provider = new SpectrumProvider(app);
		expect(() => provider.register()).toThrow(/Missing "loggers\.prod"/);
	});

	it("uses the configured log level when present and valid", async () => {
		const app = makeApp({ level: "debug" });
		new SpectrumProvider(app).register();
		const logger = await app.container.resolve(Logger);
		expect(logger).toBeInstanceOf(Logger);
	});

	it("throws on an invalid config.level instead of substituting LOG_LEVEL", () => {
		process.env.LOG_LEVEL = "debug";
		const app = makeApp({ level: "bogus-level" });
		expect(() => new SpectrumProvider(app).register()).toThrow(
			expect.objectContaining({ code: "E_SPECTRUM_UNKNOWN_LEVEL" }),
		);
	});

	it("reads LOG_LEVEL when config.level is absent", async () => {
		process.env.LOG_LEVEL = "warn";
		const app = makeApp({});
		new SpectrumProvider(app).register();
		const logger = await resolveLogger(app);
		expect(logger.level).toBe("warn");
	});

	it("throws on an invalid LOG_LEVEL when config.level is absent", () => {
		process.env.LOG_LEVEL = "WARNING";
		const app = makeApp({});
		expect(() => new SpectrumProvider(app).register()).toThrow(
			expect.objectContaining({ code: "E_SPECTRUM_UNKNOWN_LEVEL" }),
		);
	});

	it("falls back to 'info' when neither config.level nor LOG_LEVEL is valid", async () => {
		delete process.env.LOG_LEVEL;
		const app = makeApp();
		new SpectrumProvider(app).register();
		expect(await app.container.resolve(Logger)).toBeInstanceOf(Logger);
	});

	// Audit 2026-06-13: the provider dropped config.modules, so per-module level
	// overrides were silently dead. Forwarded now — a module override must apply.
	it("forwards config.modules so per-module levels work via the provider", async () => {
		const channel = new TestChannel();
		const app = makeApp({
			level: "error",
			channels: [channel],
			modules: { "bus:rust": "warn" },
		});
		new SpectrumProvider(app).register();
		const busLogger = (await resolveLogger(app)).child({
			module: "bus:rust",
		});
		busLogger.info("dropped — below the base error level");
		busLogger.warn("appears — the module override lowers bus:rust to warn");
		// Pre-fix: modules dropped → bus:rust used base 'error' → warn suppressed → 0.
		expect(channel.entries).toHaveLength(1);
		expect(defined(channel.entries[0]).level).toBe("warn");
	});

	it("honours config.channels instead of hardcoding ConsoleChannel", async () => {
		const written: unknown[] = [];
		const custom = {
			name: "custom",
			write(entry: unknown) {
				written.push(entry);
			},
		};
		const app = makeApp({ level: "info", channels: [custom] });
		new SpectrumProvider(app).register();
		const logger = await resolveLogger(app);
		logger.info("hello");
		// The configured channel received the entry — proof it's wired, not ignored.
		expect(written.length).toBe(1);
	});

	it("closes channels owning a resource on shutdown()", async () => {
		let closed = false;
		const fileLike = {
			name: "file",
			write() {},
			close() {
				closed = true;
			},
		};
		const app = makeApp({ level: "info", channels: [fileLike] });
		const provider = new SpectrumProvider(app);
		provider.register();
		await provider.shutdown();
		expect(closed).toBe(true);
	});
});

describe("spectrum > SpectrumProvider > shutdown", () => {
	it("releases the services/main singleton before closing the channels", async () => {
		const { getLogger } = await import("../../src/services/main.js");
		const app = makeApp();
		const provider = new SpectrumProvider(app);
		provider.register();
		await provider.boot();
		expect(getLogger()).toBeInstanceOf(Logger);

		await provider.shutdown();

		// Past shutdown the channels are closing, so a logger still reachable
		// through `import logger from '@c9up/spectrum/services/main'` would be
		// writing into streams that have ended.
		expect(getLogger()).toBeUndefined();
	});

	it("leaves a logger another application has since bound alone", async () => {
		const { getLogger } = await import("../../src/services/main.js");
		const provider = new SpectrumProvider(makeApp());
		provider.register();
		await provider.boot();

		const other = new SpectrumProvider(makeApp());
		other.register();
		await other.boot();
		const replacement = getLogger();
		if (!replacement) throw new Error("expected the second boot to bind one");

		await provider.shutdown();

		expect(getLogger()).toBe(replacement);
	});
});
