import { describe, expect, it } from "vitest";
import { Logger } from "../../src/Logger.js";
import { stringifyRecord } from "../../src/stringify.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

class Capture implements LogChannel {
	readonly name = "capture";
	readonly entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`not a record: ${String(value)}`);
	}
	return Object.fromEntries(Object.entries(value));
}

/** Log `err` and hand back the serialized `err` as the JSON line holds it. */
function logged(err: Error): Record<string, unknown> {
	const capture = new Capture();
	new Logger({ level: "info", channels: [capture] }).error(err);
	const [entry] = capture.entries;
	if (entry === undefined) throw new Error("nothing logged");
	const line: unknown = JSON.parse(stringifyRecord(entry));
	return record(record(line).err);
}

interface Linked extends Error {
	self?: Error;
	other?: Error;
}

describe("spectrum > err serializer cycles", () => {
	it("writes an error that references itself, the reference as [Circular]", () => {
		const err: Linked = new Error("self-ref");
		err.self = err;
		const out = logged(err);
		expect(out.message).toBe("self-ref");
		expect(out.self).toBe("[Circular]");
	});

	it("stops a cause that is the error itself after one level", () => {
		const err = new Error("loop");
		err.cause = err;
		expect(logged(err).cause).toBe("[Circular]");
	});

	it("stops a cause cycle across two errors", () => {
		const a = new Error("a");
		const b = new Error("b");
		a.cause = b;
		b.cause = a;
		const cause = record(logged(a).cause);
		expect(cause.message).toBe("b");
		expect(cause.cause).toBe("[Circular]");
	});

	it("stops an AggregateError that lists itself", () => {
		const inner = new Error("inner");
		const agg = new AggregateError([inner], "many");
		agg.errors.push(agg);
		const list = logged(agg).aggregateErrors;
		expect(Array.isArray(list)).toBe(true);
		expect(JSON.stringify(list)).toContain('"[Circular]"');
		expect(JSON.stringify(list)).toContain('"inner"');
	});

	it("serializes an error shared by two branches in both places", () => {
		const shared = new Error("shared");
		const err: Linked = new Error("outer");
		err.self = shared;
		err.other = shared;
		const out = logged(err);
		expect(record(out.self).message).toBe("shared");
		expect(record(out.other).message).toBe("shared");
	});

	it("serializes an error with many self-references in linear time", () => {
		const err = new Error("hub");
		for (let i = 0; i < 10; i++) Object.assign(err, { [`ref${i}`]: err });
		const started = performance.now();
		const out = logged(err);
		expect(performance.now() - started).toBeLessThan(100);
		expect(out.ref9).toBe("[Circular]");
	});
});
