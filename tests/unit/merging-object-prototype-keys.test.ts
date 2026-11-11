/**
 * A merging object is often a request body, so its keys are the client's.
 * A key named after an `Object.prototype` member must be logged as the data
 * it is: never looked up as a serializer, never thrown out of the log call,
 * never dropped or rewritten, and never turned into a prototype.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleChannel } from "../../src/channels/ConsoleChannel.js";
import { Logger } from "../../src/Logger.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

const KEYS = [
	"valueOf",
	"toString",
	"hasOwnProperty",
	"constructor",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"__defineGetter__",
	"__lookupGetter__",
	"__proto__",
];

/** What a JSON body parser hands a controller: own keys, any name. */
function body(key: string): unknown {
	return JSON.parse(`{"${key}":"secret-${key}","ok":"kept"}`);
}

describe("spectrum > a merging object keyed after Object.prototype members", () => {
	let stdout: string[];
	beforeEach(() => {
		stdout = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				stdout.push(String(chunk));
				return true;
			},
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes each key as an own field with its own value", () => {
		const seen: LogEntry[] = [];
		const capture: LogChannel = {
			name: "capture",
			write: (entry) => {
				seen.push(entry);
			},
		};
		const logger = new Logger({ level: "info", channels: [capture] });
		for (const key of KEYS) {
			seen.length = 0;
			expect(() => logger.info(body(key), "payload"), key).not.toThrow();
			const entry = seen[0];
			if (entry === undefined) throw new Error(`no entry for ${key}`);
			expect(Object.hasOwn(entry, key), key).toBe(true);
			expect(Reflect.get(entry, key), key).toBe(`secret-${key}`);
			expect(entry.ok).toBe("kept");
		}
	});

	it("carries each key into the JSON line, Object.prototype untouched", () => {
		const logger = new Logger({
			level: "info",
			channels: [new ConsoleChannel("json", { stream: "stdout" })],
		});
		for (const key of KEYS) {
			stdout.length = 0;
			logger.info(body(key), "payload");
			const parsed: unknown = JSON.parse(stdout.join(""));
			if (typeof parsed !== "object" || parsed === null) {
				throw new Error("expected a JSON object line");
			}
			expect(Object.hasOwn(parsed, key), key).toBe(true);
			expect(Reflect.get(parsed, key), key).toBe(`secret-${key}`);
		}
		const hostile: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
		logger.info(hostile, "payload");
		expect(Reflect.get({}, "polluted")).toBeUndefined();
	});

	it("still runs a serializer configured for a key, and the err fallback", () => {
		const seen: LogEntry[] = [];
		const logger = new Logger({
			level: "info",
			errorKey: "failure",
			serializers: { user: (value) => `user:${String(value)}` },
			channels: [
				{
					name: "capture",
					write: (entry) => {
						seen.push(entry);
					},
				},
			],
		});
		logger.info({ user: 7, failure: new Error("boom") }, "x");
		const entry = seen[0];
		expect(entry?.user).toBe("user:7");
		expect(Reflect.get(Object(entry?.failure), "message")).toBe("boom");
		expect(Reflect.get(Object(entry?.failure), "type")).toBe("Error");
	});
});
