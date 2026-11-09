import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileChannel } from "../../src/channels/FileChannel.js";
import { Logger } from "../../src/Logger.js";
import { channelsFromTargets, targets } from "../../src/targets.js";

describe("spectrum > a file-descriptor destination gets every level", () => {
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		stdout = [];
		stderr = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				stdout.push(String(chunk));
				return true;
			},
		);
		vi.spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				stderr.push(String(chunk));
				return true;
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function logTo(destination: number): Logger {
		return new Logger({
			level: "info",
			channels: channelsFromTargets([targets.file({ destination })]),
		});
	}

	it("destination 1 writes error and fatal to stdout too", () => {
		const logger = logTo(1);
		logger.info("an info");
		logger.error("an error");
		logger.fatal("a fatal");
		expect(stderr).toEqual([]);
		expect(stdout).toHaveLength(3);
		expect(stdout[1]).toContain("an error");
	});

	it("destination 2 writes info to stderr", () => {
		logTo(2).info("destination 2 means stderr");
		expect(stdout).toEqual([]);
		expect(stderr).toHaveLength(1);
		expect(stderr[0]).toContain("destination 2 means stderr");
	});

	it("no destination means stdout, as pino/file defaults to 1", () => {
		new Logger({
			level: "info",
			channels: channelsFromTargets([targets.file()]),
		}).error("defaulted");
		expect(stderr).toEqual([]);
		expect(stdout[0]).toContain("defaulted");
	});
});

describe("spectrum > any other descriptor is written to", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-fd-"));
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("writes JSON lines to the descriptor the target names", async () => {
		const file = path.join(dir, "fd.log");
		const fd = fs.openSync(file, "a");
		try {
			const channels = channelsFromTargets([targets.file({ destination: fd })]);
			const logger = new Logger({ level: "info", channels });
			logger.info("through a descriptor");
			logger.error("an error too");
			await Promise.all(channels.map((channel) => channel.close?.()));
			const lines = fs.readFileSync(file, "utf8").trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("through a descriptor");
			// The channel does not own the descriptor, so it leaves it open.
			expect(() => fs.fstatSync(fd)).not.toThrow();
		} finally {
			fs.closeSync(fd);
		}
	});

	it("rejects a channel given both a path and a descriptor, or neither", () => {
		const code = expect.objectContaining({
			code: "E_SPECTRUM_INVALID_FILE_OPTIONS",
		});
		expect(() => new FileChannel({ path: path.join(dir, "a"), fd: 3 })).toThrow(
			code,
		);
		expect(() => new FileChannel({})).toThrow(code);
		expect(() => new FileChannel({ fd: -1 })).toThrow(code);
	});
});
