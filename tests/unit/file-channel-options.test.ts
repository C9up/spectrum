import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileChannel } from "../../src/channels/FileChannel.js";
import type { LogEntry } from "../../src/types.js";

function entry(message: string): LogEntry {
	return {
		timestamp: "2026-05-04T00:00:00.000Z",
		level: "info",
		module: "test",
		message,
	};
}

const invalidOptions = expect.objectContaining({
	code: "E_SPECTRUM_INVALID_FILE_OPTIONS",
});

describe("spectrum > FileChannel options", () => {
	let dir: string;
	let file: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-opts-"));
		file = path.join(dir, "app.log");
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	for (const bad of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
		it(`rejects maxSizeBytes ${bad}`, () => {
			expect(() => new FileChannel({ path: file, maxSizeBytes: bad })).toThrow(
				invalidOptions,
			);
		});
	}

	for (const bad of [-1, 0, Number.NaN, 1.5]) {
		it(`rejects maxFiles ${bad}`, () => {
			expect(() => new FileChannel({ path: file, maxFiles: bad })).toThrow(
				invalidOptions,
			);
		});
	}

	it("keeps only the live file when maxFiles is 1", async () => {
		const channel = new FileChannel({
			path: file,
			maxSizeBytes: 150,
			maxFiles: 1,
		});
		for (let i = 0; i < 6; i++) {
			channel.write(entry(`L${i}${"x".repeat(100)}`));
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		}
		await channel.close();
		expect(await fsp.readdir(dir)).toEqual(["app.log"]);
		expect(await fsp.readFile(file, "utf8")).toContain("L5");
	});

	it("keeps maxFiles files in all, the live one included", async () => {
		const channel = new FileChannel({
			path: file,
			maxSizeBytes: 150,
			maxFiles: 3,
		});
		for (let i = 0; i < 8; i++) {
			channel.write(entry(`L${i}${"x".repeat(100)}`));
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		}
		await channel.close();
		expect((await fsp.readdir(dir)).sort()).toEqual([
			"app.log",
			"app.log.1",
			"app.log.2",
		]);
		expect(await fsp.readFile(file, "utf8")).toContain("L7");
		expect(await fsp.readFile(`${file}.1`, "utf8")).toContain("L6");
		expect(await fsp.readFile(`${file}.2`, "utf8")).toContain("L5");
	});
});
