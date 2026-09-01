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

describe("spectrum > close() is terminal", () => {
	let dir: string;
	let logPath: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-close-"));
		logPath = path.join(dir, "app.log");
	});

	afterEach(async () => {
		await flush();
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("writes nothing after close, and does not reopen the file", async () => {
		const ch = new FileChannel({ path: logPath });
		ch.write(makeEntry({ msg: "before" }));
		ch.close();
		ch.write(makeEntry({ msg: "after" }));
		await flush();

		// `close()` only nulled the stream, and `write()` reopens a null stream —
		// so the second line silently reopened the file and appended to it.
		const body = fs.readFileSync(logPath, "utf8");
		expect(body).toContain("before");
		expect(body).not.toContain("after");
	});

	it("flushes what a rotation had buffered rather than dropping it", async () => {
		// Small enough that the second line triggers a rotation and lands in the
		// pending buffer.
		const ch = new FileChannel({ path: logPath, maxSizeBytes: 120 });
		ch.write(makeEntry({ msg: "x".repeat(100) }));
		ch.write(makeEntry({ msg: "buffered-line" }));
		ch.close();
		await flush();

		// Those lines were accepted; dropping them at close loses log the caller
		// believed was written.
		const written = fs
			.readdirSync(dir)
			.map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
			.join("");
		expect(written).toContain("buffered-line");
	});

	it("is safe to call twice", () => {
		const ch = new FileChannel({ path: logPath });
		ch.write(makeEntry({ msg: "one" }));

		expect(() => {
			ch.close();
			ch.close();
		}).not.toThrow();
	});
});

describe("spectrum > FileChannel close during rotation", () => {
	let dir: string;
	let logPath: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-close-"));
		logPath = path.join(dir, "app.log");
	});

	afterEach(async () => {
		await flush(80);
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("keeps lines it accepted when close() lands mid-rotation", async () => {
		// A rotation nulls #stream before awaiting the old stream's end, and
		// close() used to splice #pending and then find no stream to write it
		// to — so lines the channel had already accepted vanished.
		const channel = new FileChannel({
			path: logPath,
			maxSizeBytes: 200,
			maxFiles: 3,
		});

		// Overflow to schedule a rotation, then buffer a line behind it.
		channel.write(makeEntry({ message: "x".repeat(300) }));
		channel.write(makeEntry({ message: "MARKER" }));

		// close() inside the rotation window: the microtask has run, the stream
		// is nulled, and the new one is not open yet.
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		channel.close();
		await flush(80);

		const files = (await fsp.readdir(dir)).sort();
		const contents = files
			.map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
			.join("");
		expect(contents, `files: ${files.join(", ")}`).toContain("MARKER");
	});

	it("stays closed — a rotation in flight does not bring the file back", async () => {
		const channel = new FileChannel({ path: logPath, maxSizeBytes: 200 });
		channel.write(makeEntry({ message: "y".repeat(300) }));
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		channel.close();
		await flush(80);

		channel.write(makeEntry({ message: "AFTER-CLOSE" }));
		await flush(40);
		const contents = (await fsp.readdir(dir))
			.map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
			.join("");
		expect(contents).not.toContain("AFTER-CLOSE");
	});
});

describe("spectrum > rotation keeps every generation", () => {
	let dir: string;
	let logPath: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-rot-"));
		logPath = path.join(dir, "app.log");
	});

	afterEach(async () => {
		await flush(80);
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("shifts .1 to .2 instead of moving the live file straight to .2", async () => {
		// The loop renamed the ACTIVE file to `.2` on its i===1 pass, so `.1` was
		// never written and the follow-up rename of the live file found nothing.
		// With maxFiles=3 that keeps ONE generation where two were configured,
		// and each rotation destroys the one before it.
		const channel = new FileChannel({
			path: logPath,
			maxSizeBytes: 150,
			maxFiles: 3,
		});

		channel.write(makeEntry({ message: `A${"a".repeat(200)}` }));
		await flush(60);
		channel.write(makeEntry({ message: `B${"b".repeat(200)}` }));
		await flush(60);
		channel.write(makeEntry({ message: `C${"c".repeat(200)}` }));
		await flush(60);
		channel.close();
		await flush(60);

		const files = (await fsp.readdir(dir)).sort();
		expect(files).toContain("app.log.1");
		expect(files).toContain("app.log.2");

		// Both older generations survive, in order: .1 is the most recent of them.
		const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
		const all = files.map(read).join("");
		expect(all).toContain("A");
		expect(all).toContain("B");
	});

	it("writes an entry larger than maxSizeBytes instead of rotating forever", async () => {
		// The size check rotated whenever `current + bytes > max`. After a
		// rotation `current` is 0, so a line bigger than `max` on its own still
		// failed the check — it went back on the buffer, scheduled another
		// rotation, and was never written at all.
		const channel = new FileChannel({
			path: logPath,
			maxSizeBytes: 50,
			maxFiles: 3,
		});

		channel.write(makeEntry({ message: `OVERSIZED${"x".repeat(500)}` }));
		await flush(120);

		// Written WITHOUT close(): the point is that it lands, not that a
		// shutdown flush eventually rescues it.
		const onDisk = () =>
			fs
				.readdirSync(dir)
				.map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
				.join("");
		expect(onDisk()).toContain("OVERSIZED");

		// …and it did not churn through the generations getting there: a fresh
		// file plus at most the one it rotated out of.
		expect((await fsp.readdir(dir)).length).toBeLessThanOrEqual(2);

		channel.close();
		await flush(60);
		expect(onDisk()).toContain("OVERSIZED");
	});
});
