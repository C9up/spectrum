import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleChannel } from "../../src/channels/ConsoleChannel.js";
import { FileChannel } from "../../src/channels/FileChannel.js";
import { Logger } from "../../src/Logger.js";
import { channelsFromTargets, targets } from "../../src/targets.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

class Capture implements LogChannel {
	readonly name = "capture";
	readonly entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

const unsupported = expect.objectContaining({
	code: "E_SPECTRUM_UNSUPPORTED_TARGET",
});

describe("spectrum > a target spectrum cannot honour fails loudly", () => {
	for (const target of [
		"pino-loki",
		"pino-socket",
		"@logtail/pino",
		"pino-roll",
		"pino/pretty",
	]) {
		it(`rejects ${target} instead of writing JSON to stdout`, () => {
			expect(() =>
				channelsFromTargets([{ target, options: { host: "http://loki" } }]),
			).toThrow(unsupported);
			expect(
				() =>
					new Logger({
						level: "info",
						transport: { targets: [{ target }] },
					}),
			).toThrow(new RegExp(target.replace(/[/.]/g, "\\$&")));
		});
	}

	it("keeps building the targets it knows", () => {
		const [pretty, file, fd] = channelsFromTargets([
			targets.pretty(),
			targets.file({ destination: "/tmp/spectrum-known.log" }),
			targets.file({ destination: 1 }),
		]);
		expect(pretty).toBeInstanceOf(ConsoleChannel);
		expect(file).toBeInstanceOf(FileChannel);
		expect(fd).toBeInstanceOf(ConsoleChannel);
	});

	it("accepts a channel as the target, with the target's own level", () => {
		const capture = new Capture();
		const logger = new Logger({
			level: "debug",
			transport: {
				targets: targets().push({ target: capture, level: "warn" }).toArray(),
			},
		});
		logger.info("below the target level");
		logger.warn("at the target level");
		expect(capture.entries.map((entry) => entry.message)).toEqual([
			"at the target level",
		]);
	});
});

describe("spectrum > target options that change what is written", () => {
	let dir: string;
	let stdout: string[];
	let stderr: string[];

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-targets-"));
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

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("pretty with destination 2 writes every level to stderr", () => {
		new Logger({
			level: "info",
			channels: channelsFromTargets([targets.pretty({ destination: 2 })]),
		}).info("pretty to stderr");
		expect(stdout).toEqual([]);
		expect(stderr.join("")).toContain("pretty to stderr");
	});

	it("pretty with a destination it cannot write to is refused", () => {
		expect(() =>
			channelsFromTargets([
				{ target: "pino-pretty", options: { destination: "/tmp/pretty.log" } },
			]),
		).toThrow(
			expect.objectContaining({ code: "E_SPECTRUM_UNSUPPORTED_TARGET" }),
		);
	});

	it("file with append: false starts the file over", async () => {
		const file = path.join(dir, "app.log");
		fs.writeFileSync(file, '{"old":true}\n');
		const channels = channelsFromTargets([
			targets.file({ destination: file, append: false }),
		]);
		new Logger({ level: "info", channels }).info("fresh");
		await Promise.all(channels.map((channel) => channel.close?.()));
		const body = fs.readFileSync(file, "utf8");
		expect(body).not.toContain("old");
		expect(body).toContain("fresh");
	});
});
