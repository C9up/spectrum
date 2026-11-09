import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../../src/Logger.js";
import { channelsFromTargets, targets } from "../../src/targets.js";

describe("spectrum > a leveled target's close", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-leveled-"));
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("resolves only once the file behind it is flushed", async () => {
		const file = path.join(dir, "app.log");
		// The target inherits 'info', so the file channel is wrapped.
		const channels = channelsFromTargets(
			[targets.file({ destination: file })],
			"info",
		);
		const logger = new Logger({ level: "info", channels });
		for (let i = 0; i < 2000; i++) logger.info({ i }, `line-${i}`);

		await Promise.all(channels.map((channel) => channel.close?.()));

		// Read immediately: no sleep between the awaited close and the read.
		const lines = (await fsp.readFile(file, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(2000);
		expect(lines[1999]).toContain("line-1999");
	});

	it("hands back the inner close's promise, for shutdown to await and report", async () => {
		const [leveled] = channelsFromTargets(
			[targets.file({ destination: path.join(dir, "x.log") }, "error")],
			"info",
		);
		expect(leveled).toBeDefined();
		const result = leveled?.close?.();
		expect(result).toBeInstanceOf(Promise);
		await result;
	});
});
