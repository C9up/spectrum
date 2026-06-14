import { describe, expect, it } from "vitest";
import { FakeLogger } from "../../src/testing/FakeLogger.js";
import type { LogEntry } from "../../src/types.js";

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		level: overrides.level ?? "info",
		message: overrides.message ?? "hello",
		module: overrides.module ?? "app",
		correlationId: overrides.correlationId,
		timestamp: overrides.timestamp ?? new Date().toISOString(),
		data: overrides.data,
	};
}

describe("FakeLogger — LogChannel surface", () => {
	it("write captures the entry", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ message: "first" }));
		expect(log.getLogged()).toHaveLength(1);
		expect(log.getLogged()[0].message).toBe("first");
	});

	it("getLogged returns a defensive snapshot", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ data: { userId: 1 } }));
		const snap = log.getLogged();
		snap[0].message = "mutated";
		if (snap[0].data) snap[0].data.userId = 99;
		expect(log.getLogged()[0].message).toBe("hello");
		expect(log.getLogged()[0].data?.userId).toBe(1);
	});

	it("captures an entry whose data carries a non-cloneable value (no drop)", () => {
		// structuredClone throws DataCloneError on functions/class instances;
		// that throw used to propagate into Logger.log's swallow-to-stderr, so
		// the entry was never captured and assertLogged failed misleadingly
		// (audit 2026-06-13). The fallback must still capture the entry.
		const log = new FakeLogger();
		log.write(makeEntry({ message: "with-fn", data: { cb: () => 1, n: 7 } }));
		const logged = log.getLogged();
		expect(logged).toHaveLength(1);
		expect(logged[0].message).toBe("with-fn");
		// The non-cloneable bits degrade gracefully; cloneable data survives.
		expect(logged[0].data?.n).toBe(7);
	});

	it("reset clears the captured array", () => {
		const log = new FakeLogger();
		log.write(makeEntry());
		log.write(makeEntry());
		log.reset();
		expect(log.getLogged()).toHaveLength(0);
	});

	it("has a `name` property (LogChannel contract)", () => {
		const log = new FakeLogger();
		expect(log.name).toBe("fake");
	});
});

describe("FakeLogger — assertLogged", () => {
	it("passes when at least one entry matches the level", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ level: "info" }));
		expect(() => log.assertLogged("info")).not.toThrow();
	});

	it("throws when no entry matches the level", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ level: "info" }));
		expect(() => log.assertLogged("error")).toThrow(
			/no captured entry matches/,
		);
	});

	it("containing narrows by message substring", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ level: "warn", message: "disk almost full" }));
		expect(() =>
			log.assertLogged("warn", { containing: "disk" }),
		).not.toThrow();
		expect(() => log.assertLogged("warn", { containing: "memory" })).toThrow(
			/no captured entry matches/,
		);
	});

	it("rejects empty `containing` (would match every entry)", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ level: "info" }));
		expect(() => log.assertLogged("info", { containing: "" })).toThrow(
			/cannot be an empty string/,
		);
	});

	it("dataMatches narrows by data predicate", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ level: "info", data: { userId: 1 } }));
		expect(() =>
			log.assertLogged("info", {
				dataMatches: (d) => (d as { userId: number }).userId === 1,
			}),
		).not.toThrow();
		expect(() =>
			log.assertLogged("info", {
				dataMatches: (d) => (d as { userId: number }).userId === 99,
			}),
		).toThrow(/no captured entry matches/);
	});

	it("function predicate gives full entry access", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ level: "error", module: "auth" }));
		expect(() =>
			log.assertLogged("error", (e) => e.module === "auth"),
		).not.toThrow();
		expect(() => log.assertLogged("error", (e) => e.module === "mail")).toThrow(
			/no captured entry matches/,
		);
	});

	it("error message includes captured summary", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ level: "info", message: "started" }));
		let err: unknown;
		try {
			log.assertLogged("error");
		} catch (e) {
			err = e;
		}
		expect(String(err)).toContain("Captured (1)");
		expect(String(err)).toContain("started");
	});
});

describe("FakeLogger — assertNotLogged", () => {
	it("passes when no entry matches the level", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ level: "info" }));
		expect(() => log.assertNotLogged("error")).not.toThrow();
	});

	it("throws when at least one entry matches", () => {
		const log = new FakeLogger();
		log.write(makeEntry({ level: "error" }));
		expect(() => log.assertNotLogged("error")).toThrow(
			/at least one captured entry matches/,
		);
	});
});
