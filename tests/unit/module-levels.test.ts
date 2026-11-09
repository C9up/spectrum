import { describe, expect, it } from "vitest";
import { Logger } from "../../src/Logger.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

class Capture implements LogChannel {
	readonly name = "capture";
	readonly entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

describe("spectrum > per-module levels read own entries only", () => {
	it("keeps a module named after an Object.prototype member at the logger's level", () => {
		const capture = new Capture();
		const logger = new Logger({
			level: "error",
			channels: [capture],
			modules: { db: "debug" },
		});
		for (const module of [
			"constructor",
			"toString",
			"__proto__",
			"hasOwnProperty",
			"valueOf",
		]) {
			const child = logger.child({ module });
			child.info("should not be written");
			expect(child.isLevelEnabled("info")).toBe(false);
			child.error("written");
		}
		expect(capture.entries.map((entry) => entry.level)).toEqual([
			"error",
			"error",
			"error",
			"error",
			"error",
		]);
	});

	it("still honours a real override", () => {
		const capture = new Capture();
		const logger = new Logger({
			level: "error",
			channels: [capture],
			modules: { db: "debug" },
		});
		logger.child({ module: "db" }).debug("db debug");
		logger.child({ module: "app" }).info("app info");
		expect(capture.entries.map((entry) => entry.message)).toEqual(["db debug"]);
	});

	it("honours an override for a module that is named like a prototype member", () => {
		const capture = new Capture();
		const modules: Record<string, "debug"> = {};
		Object.defineProperty(modules, "constructor", {
			value: "debug",
			enumerable: true,
		});
		const logger = new Logger({ level: "error", channels: [capture], modules });
		logger.child({ module: "constructor" }).debug("own override");
		expect(capture.entries).toHaveLength(1);
	});
});
