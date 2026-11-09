import { describe, expect, it } from "vitest";
import { Logger } from "../../src/Logger.js";
import { logLevel } from "../../src/types.js";

const unknownLevel = expect.objectContaining({
	code: "E_SPECTRUM_UNKNOWN_LEVEL",
});

describe("spectrum > an unknown level fails instead of logging at info", () => {
	for (const bad of ["ERROR", "warning", "verbose", "", "constructor"]) {
		it(`rejects level ${JSON.stringify(bad)} at construction`, () => {
			expect(() => Reflect.construct(Logger, [{ level: bad }])).toThrow(
				unknownLevel,
			);
		});

		it(`rejects level ${JSON.stringify(bad)} in the setter`, () => {
			const logger = new Logger({ level: "error", channels: [] });
			expect(() => Reflect.set(logger, "level", bad)).toThrow(unknownLevel);
			expect(logger.level).toBe("error");
		});

		it(`rejects module level ${JSON.stringify(bad)} at construction`, () => {
			expect(() =>
				Reflect.construct(Logger, [{ level: "info", modules: { db: bad } }]),
			).toThrow(unknownLevel);
		});
	}

	it("keeps accepting every level, silent included", () => {
		for (const level of [
			"trace",
			"debug",
			"info",
			"warn",
			"error",
			"fatal",
			"silent",
		] as const) {
			const logger = new Logger({ level, modules: { db: level } });
			logger.level = level;
			expect(logger.level).toBe(level);
		}
	});
});

describe("spectrum > logLevel(raw)", () => {
	it("falls back when the value is absent", () => {
		expect(logLevel(undefined)).toBe("info");
		expect(logLevel("")).toBe("info");
		expect(logLevel(undefined, "warn")).toBe("warn");
	});

	it("returns a valid level", () => {
		expect(logLevel("debug")).toBe("debug");
		expect(logLevel("silent")).toBe("silent");
	});

	it("throws on a value that is set but is no level", () => {
		for (const bad of ["ERROR", "warning", "verbose", "10"]) {
			expect(() => logLevel(bad)).toThrow(unknownLevel);
		}
	});
});
