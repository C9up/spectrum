import { afterEach, describe, expect, it } from "vitest";
import { defineConfig } from "../../src/config.js";
import { LoggerManager } from "../../src/LoggerManager.js";
import SpectrumProvider from "../../src/SpectrumProvider.js";
import type { LogChannel, LogConfig, LogEntry } from "../../src/types.js";
import { makeApp } from "../helpers/app.js";

const INHERITED = ["__proto__", "constructor", "toString", "hasOwnProperty"];

const lines: LogEntry[] = [];
const channel: LogChannel = {
	name: "capture",
	write: (entry) => void lines.push(entry),
};

function manager(): LoggerManager {
	return new LoggerManager({
		default: "app",
		loggers: { app: { level: "info", channels: [channel] } },
	});
}

afterEach(() => {
	Reflect.deleteProperty(Object.prototype, "name");
	lines.length = 0;
});

describe("LoggerManager resolves a logger name among its own entries only", () => {
	it("use() refuses a name inherited from Object.prototype", () => {
		const m = manager();
		for (const name of INHERITED) {
			expect(() => m.use(name)).toThrow(
				expect.objectContaining({ code: "E_SPECTRUM_UNKNOWN_LOGGER" }),
			);
		}
		expect(Object.hasOwn(Object.prototype, "name")).toBe(false);
		expect(Reflect.get({}, "name")).toBeUndefined();
	});

	it("use() still finds a declared logger and names it after its key", () => {
		const declared: LogConfig = { level: "info", channels: [channel] };
		const m = new LoggerManager({
			default: "app",
			loggers: { app: declared, audit: declared },
		});
		m.use("audit").info("written");
		expect(lines[0]?.name).toBe("audit");
		// The config handed in is not written to.
		expect(declared.name).toBeUndefined();
	});

	it("a logger declared under an inherited name is a logger like any other", () => {
		const loggers: Record<string, LogConfig> = Object.create(null);
		for (const name of ["constructor", "app"]) {
			loggers[name] = { level: "info", channels: [channel] };
		}
		const m = new LoggerManager({ default: "app", loggers });
		m.use("constructor").info("written");
		expect(lines[0]?.name).toBe("constructor");
	});

	it("the constructor and defineConfig refuse an inherited default", () => {
		for (const name of INHERITED) {
			const config = {
				default: name,
				loggers: { app: { level: "info" as const, channels: [channel] } },
			};
			expect(() => new LoggerManager(config)).toThrow(
				expect.objectContaining({ code: "E_SPECTRUM_UNKNOWN_DEFAULT_LOGGER" }),
			);
			expect(() => defineConfig(config)).toThrow(
				expect.objectContaining({ code: "E_SPECTRUM_UNKNOWN_DEFAULT_LOGGER" }),
			);
		}
	});

	it("the provider refuses an inherited default at boot", () => {
		for (const name of INHERITED) {
			const provider = new SpectrumProvider(
				makeApp({
					default: name,
					loggers: { app: { level: "info", channels: [channel] } },
				}),
			);
			expect(() => provider.register()).toThrow(
				expect.objectContaining({ code: "E_SPECTRUM_UNKNOWN_DEFAULT_LOGGER" }),
			);
		}
	});

	it("the provider keeps a logger declared as __proto__ as an entry", () => {
		const loggers: unknown = JSON.parse(
			'{"__proto__":{"level":"info"},"app":{"level":"info"}}',
		);
		const provider = new SpectrumProvider(
			makeApp({ default: "__proto__", loggers }),
		);
		expect(() => provider.register()).not.toThrow();
		expect(Object.hasOwn(Object.prototype, "level")).toBe(false);
	});
});
