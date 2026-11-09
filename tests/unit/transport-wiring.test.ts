/**
 * What a migrated `config/logger.ts` declares has to reach the destination it
 * names, at the level it names it — through the provider, which is the only
 * path a running application takes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileChannel } from "../../src/channels/FileChannel.js";
import { Logger } from "../../src/Logger.js";
import SpectrumProvider from "../../src/SpectrumProvider.js";
import { channelsFromTargets, targets } from "../../src/targets.js";
import type { LogChannel, LogEntry } from "../../src/types.js";
import { makeApp, resolveLogger } from "../helpers/app.js";

/** One log entry, for a channel asked what it lets through. */
function entryAt(level: LogEntry["level"], message: string): LogEntry {
	return {
		level,
		message,
		module: "app",
		timestamp: new Date().toISOString(),
	};
}

/**
 * Everything a file channel actually received.
 *
 * The stream flushes on its own schedule, so this waits for content rather
 * than for a fixed delay — a fixed one is a flake on a loaded runner. An empty
 * result after the whole budget is a real answer: nothing was written.
 */
async function linesIn(destination: string): Promise<string> {
	const deadline = Date.now() + 2000;
	for (;;) {
		const found = fs.existsSync(destination)
			? fs.readFileSync(destination, "utf8")
			: "";
		if (found.length > 0 || Date.now() > deadline) return found;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const written: string[] = [];

afterEach(() => {
	for (const file of written.splice(0)) fs.rmSync(file, { force: true });
});

function tempLogPath(): string {
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "spectrum-")),
		"app.log",
	);
	written.push(file);
	return file;
}

describe("spectrum > a transport config through the provider", () => {
	it("writes to the file the config named", async () => {
		const destination = tempLogPath();
		const app = makeApp({
			default: "app",
			loggers: {
				app: {
					level: "info",
					transport: {
						targets: targets().push(targets.file({ destination })).toArray(),
					},
				},
			},
		});
		const provider = new SpectrumProvider(app);
		provider.register();
		const logger = await resolveLogger(app);

		logger.info("to disk");
		await provider.shutdown();

		// Pre-fix the provider filled `channels` in with a console before the
		// Logger's own conversion could run, so the declared file target was
		// replaced and this file was never created at all.
		expect(await linesIn(destination)).toContain("to disk");
	});

	it("still falls back to a console when nothing is declared", async () => {
		const app = makeApp({ level: "info" });
		new SpectrumProvider(app).register();

		expect(await app.container.resolve(Logger)).toBeInstanceOf(Logger);
	});
});

describe("spectrum > a target's own level", () => {
	it("keeps below-level entries out of that destination", async () => {
		const destination = tempLogPath();
		const [channel] = channelsFromTargets([
			targets.file({ destination }, "error"),
		]);
		if (!channel) throw new Error("expected a channel");

		channel.write(entryAt("debug", "noisy"));
		channel.write(entryAt("error", "real"));

		// Pre-fix `targets.file(..., 'error')` was accepted and then dropped, so
		// the file the deployment scoped to errors received every debug line the
		// application wrote — request bodies and tokens included.
		const written = await linesIn(destination);
		expect(written).toContain("real");
		expect(written).not.toContain("noisy");
		// `noisy` never arriving is the point, so the wait above has to have
		// been long enough for something to arrive at all.
		expect(written).not.toBe("");
	});

	it("inherits the logger's level when the target names none", async () => {
		const destination = tempLogPath();
		const [channel] = channelsFromTargets(
			[targets.file({ destination })],
			"warn",
		);
		if (!channel) throw new Error("expected a channel");

		channel.write(entryAt("info", "below"));
		channel.write(entryAt("warn", "at"));

		const written = await linesIn(destination);
		expect(written).toContain("at");
		expect(written).not.toContain("below");
	});

	it("still closes the file underneath a level gate", async () => {
		const destination = tempLogPath();
		const [channel] = channelsFromTargets([
			targets.file({ destination }, "error"),
		]);
		if (!channel) throw new Error("expected a channel");
		expect(channel).not.toBeInstanceOf(FileChannel);

		channel.write(entryAt("error", "kept"));
		// The gate is what the provider now holds, so a channel that owns a
		// stream is only released if the wrapper passes `close` along.
		const closable: LogChannel & { close?: () => void } = channel;
		closable.close?.();

		expect(await linesIn(destination)).toContain("kept");
	});

	it("refuses a level nobody can act on", () => {
		expect(() =>
			channelsFromTargets([targets.file({ destination: 1 }, "verbose")]),
		).toThrow(/Unknown transport target level "verbose"/);
	});
});
