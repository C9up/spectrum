import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileChannel } from "../../src/channels/FileChannel.js";
import type { LogEntry } from "../../src/types.js";

/** Narrow away null/undefined without a `!` non-null assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
	return {
		timestamp: "2026-05-04T00:00:00.000Z",
		level: "info",
		module: "test",
		message: "msg",
		...over,
	};
}

async function flush(ms = 60) {
	await new Promise<void>((r) => setTimeout(r, ms));
}

describe("spectrum > FileChannel", () => {
	let dir: string;
	let logPath: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-file-"));
		logPath = path.join(dir, "app.log");
	});

	afterEach(async () => {
		// Allow any in-flight rotation/stream end callbacks to finish before
		// teardown — otherwise rmdir races with file creation during rotation.
		await flush(150);
		await fsp.rm(dir, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 50,
		});
	});

	it("writes a JSON line per entry, creating the directory if missing", async () => {
		const nestedPath = path.join(dir, "nested", "deep", "app.log");
		const ch = new FileChannel({ path: nestedPath });
		ch.write(makeEntry({ message: "first" }));
		ch.write(makeEntry({ message: "second" }));
		ch.close();
		await flush();

		const content = await fsp.readFile(nestedPath, "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(defined(lines[0])).message).toBe("first");
		expect(JSON.parse(defined(lines[1])).message).toBe("second");
	});

	it("appends to an existing file (initial #currentSize from statSync)", async () => {
		await fsp.writeFile(logPath, '{"pre":"existing"}\n');
		const ch = new FileChannel({ path: logPath });
		ch.write(makeEntry({ message: "after" }));
		ch.close();
		await flush();
		const content = await fsp.readFile(logPath, "utf8");
		expect(content).toContain('"pre":"existing"');
		expect(content).toContain('"after"');
	});

	it("close() releases the stream so the file is no longer locked", async () => {
		const ch = new FileChannel({ path: logPath });
		ch.write(makeEntry());
		ch.close();
		await flush();
		const second = fs.createWriteStream(logPath, { flags: "a" });
		await new Promise<void>((resolve) => second.end(resolve));
	});

	it("close() is idempotent when called twice", async () => {
		const ch = new FileChannel({ path: logPath });
		ch.write(makeEntry());
		ch.close();
		expect(() => ch.close()).not.toThrow();
		await flush();
	});
});
