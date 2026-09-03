/**
 * The bridge replaces `process.stderr.write` for the whole process, so
 * everything else in the process writes through it — not only the Rust lines
 * it is there to catch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRustLogBridge, parseRustLog } from "../../src/RustLogBridge.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

class Capture implements LogChannel {
	name = "capture";
	entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

const started: Array<{ stop: () => void }> = [];
let restoreStderr: (() => void) | undefined;

/**
 * Start a bridge over a stderr the test can read.
 *
 * The collector goes in FIRST, so the bridge saves it as the original: what the
 * bridge passes through lands in the array instead of the terminal, and what it
 * intercepts can be told apart from what it did not.
 */
function bridging(channels: LogChannel[]): string[] {
	const passedThrough: string[] = [];
	const original = process.stderr.write;
	type WriteCallback = (error?: Error | null) => void;
	process.stderr.write = (
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | WriteCallback,
		callback?: WriteCallback,
	): boolean => {
		passedThrough.push(String(chunk));
		const done =
			typeof callback === "function"
				? callback
				: typeof encodingOrCallback === "function"
					? encodingOrCallback
					: undefined;
		done?.();
		return true;
	};
	restoreStderr = () => {
		process.stderr.write = original;
	};

	const bridge = createRustLogBridge(channels);
	started.push(bridge);
	bridge.start();
	return passedThrough;
}

afterEach(() => {
	for (const bridge of started.splice(0)) bridge.stop();
	restoreStderr?.();
	restoreStderr = undefined;
});

describe("spectrum > parsing a Rust log line", () => {
	it("reads the level and the module", () => {
		expect(
			parseRustLog("[INFO ream_http] listening on 0.0.0.0:3000"),
		).toMatchObject({
			level: "info",
			module: "ream-http",
			message: "listening on 0.0.0.0:3000",
		});
	});

	it("refuses a line that is not one", () => {
		expect(parseRustLog("thread 'main' panicked")).toBeNull();
		expect(parseRustLog("[VERBOSE ream_http] nope")).toBeNull();
	});
});

describe("spectrum > the stderr callback", () => {
	it("is called when a Rust line is the whole chunk", async () => {
		const channel = new Capture();
		bridging([channel]);

		const flushed = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 200);
			process.stderr.write("[WARN ream_bus] slow dispatch\n", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});

		// Intercepting the line used to return `true` and drop the callback, so
		// anything waiting on the flush waited forever.
		expect(flushed).toBe(true);
		expect(channel.entries).toHaveLength(1);
	});

	it("is called when only part of the chunk was a Rust line", async () => {
		const channel = new Capture();
		const passedThrough = bridging([channel]);

		const flushed = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 200);
			process.stderr.write("[INFO ream_http] up\nplain output\n", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});

		expect(flushed).toBe(true);
		expect(channel.entries).toHaveLength(1);
		// Only the half it did not claim goes on to stderr, newline intact.
		expect(passedThrough).toEqual(["plain output\n"]);
	});

	it("is called when nothing was intercepted", async () => {
		const channel = new Capture();
		const passedThrough = bridging([channel]);

		const flushed = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 200);
			process.stderr.write("nothing to parse here\n", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});

		expect(flushed).toBe(true);
		expect(channel.entries).toHaveLength(0);
		expect(passedThrough).toEqual(["nothing to parse here\n"]);
	});
});

describe("spectrum > stopping the bridge", () => {
	it("puts the original write back", () => {
		const before = process.stderr.write;
		const bridge = createRustLogBridge([new Capture()]);
		bridge.start();
		expect(process.stderr.write).not.toBe(before);
		bridge.stop();
		expect(process.stderr.write).toBe(before);
	});
});
