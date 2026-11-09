import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../../src/Logger.js";
import logger, { clearLogger, setLogger } from "../../src/services/main.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

class Capture implements LogChannel {
	readonly name = "capture";
	readonly entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

describe("spectrum > services/main before boot", () => {
	afterEach(() => {
		clearLogger();
	});

	it("is not thenable, so awaiting or resolving it does not throw", async () => {
		expect(Reflect.get(logger, "then")).toBeUndefined();
		await expect(Promise.resolve(logger)).resolves.toBe(logger);
	});

	it("answers undefined for symbols a loader or formatter reads", () => {
		expect(Reflect.get(logger, Symbol.toStringTag)).toBeUndefined();
		expect(Reflect.get(logger, Symbol.toPrimitive)).toBeUndefined();
		expect(Reflect.get(logger, Symbol.for("nodejs.util.inspect.custom"))).toBe(
			undefined,
		);
	});

	it("still reports a real access made too early", () => {
		expect(() => logger.info("too early")).toThrow(
			/before SpectrumProvider\.boot\(\) ran/,
		);
		expect(() => logger.level).toThrow(/before SpectrumProvider\.boot/);
	});

	it("forwards to the bound logger once set", () => {
		const capture = new Capture();
		setLogger(new Logger({ level: "info", channels: [capture] }));
		logger.info("after boot");
		expect(capture.entries.map((entry) => entry.message)).toEqual([
			"after boot",
		]);
	});
});
