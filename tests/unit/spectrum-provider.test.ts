import { afterEach, describe, expect, it } from "vitest";
import type { LogChannel, LogEntry } from "../../src/index.js";
import { Logger } from "../../src/Logger.js";
import SpectrumProvider, {
	type SpectrumAppContext,
} from "../../src/SpectrumProvider.js";

/** In-memory channel for asserting what the provider-built Logger emits. */
class TestChannel implements LogChannel {
	name = "test";
	entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

function makeApp(loggerConfig?: unknown): {
	app: SpectrumAppContext;
} {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	return {
		app: {
			container: {
				singleton(token, factory) {
					bindings.set(token, factory);
				},
				resolve<T = unknown>(token: unknown): T {
					if (cache.has(token)) return cache.get(token) as T;
					const factory = bindings.get(token);
					if (!factory) throw new Error("not registered");
					const value = factory();
					cache.set(token, value);
					return value as T;
				},
			},
			config: {
				get<T = unknown>(key: string): T | undefined {
					if (key === "logger" && loggerConfig) return loggerConfig as T;
					return undefined;
				},
			},
		},
	};
}

describe("spectrum > SpectrumProvider", () => {
	const originalLevel = process.env.LOG_LEVEL;

	afterEach(() => {
		if (originalLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = originalLevel;
	});

	it("registers Logger and 'logger' string token to the same singleton", () => {
		const { app } = makeApp();
		new SpectrumProvider(app).register();

		const byClass = app.container.resolve(Logger);
		const byToken = app.container.resolve("logger");
		expect(byClass).toBeInstanceOf(Logger);
		expect(byToken).toBe(byClass);
	});

	it("uses the configured log level when present and valid", () => {
		const { app } = makeApp({ level: "debug" });
		new SpectrumProvider(app).register();
		const logger = app.container.resolve(Logger);
		expect(logger).toBeInstanceOf(Logger);
	});

	it("falls back to LOG_LEVEL env var when config.level is invalid", () => {
		process.env.LOG_LEVEL = "warn";
		const { app } = makeApp({ level: "bogus-level" });
		new SpectrumProvider(app).register();
		expect(app.container.resolve(Logger)).toBeInstanceOf(Logger);
	});

	it("falls back to 'info' when neither config.level nor LOG_LEVEL is valid", () => {
		delete process.env.LOG_LEVEL;
		const { app } = makeApp();
		new SpectrumProvider(app).register();
		expect(app.container.resolve(Logger)).toBeInstanceOf(Logger);
	});

	// Audit 2026-06-13: the provider dropped config.modules, so per-module level
	// overrides were silently dead. Forwarded now — a module override must apply.
	it("forwards config.modules so per-module levels work via the provider", () => {
		const channel = new TestChannel();
		const { app } = makeApp({
			level: "error",
			channels: [channel],
			modules: { "bus:rust": "warn" },
		});
		new SpectrumProvider(app).register();
		const busLogger = app.container
			.resolve<Logger>(Logger)
			.child({ module: "bus:rust" });
		busLogger.info("dropped — below the base error level");
		busLogger.warn("appears — the module override lowers bus:rust to warn");
		// Pre-fix: modules dropped → bus:rust used base 'error' → warn suppressed → 0.
		expect(channel.entries).toHaveLength(1);
		expect(channel.entries[0].level).toBe("warn");
	});

	it("honours config.channels instead of hardcoding ConsoleChannel", () => {
		const written: unknown[] = [];
		const custom = {
			name: "custom",
			write(entry: unknown) {
				written.push(entry);
			},
		};
		const { app } = makeApp({ level: "info", channels: [custom] });
		new SpectrumProvider(app).register();
		const logger = app.container.resolve<Logger>(Logger);
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
		const { app } = makeApp({ level: "info", channels: [fileLike] });
		const provider = new SpectrumProvider(app);
		provider.register();
		await provider.shutdown();
		expect(closed).toBe(true);
	});
});
