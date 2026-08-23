/**
 * A migrated `config/logger.ts` declares its output through `transport.targets`.
 * Spectrum writes through channels, so the config has to convert — otherwise it
 * is accepted and silently ignored, and the app's logs go nowhere it asked for.
 */
import { describe, expect, it, vi } from "vitest";
import { ConsoleChannel } from "../../src/channels/ConsoleChannel.js";
import { FileChannel } from "../../src/channels/FileChannel.js";
import { Logger } from "../../src/Logger.js";
import { channelsFromTargets, targets } from "../../src/targets.js";

describe("spectrum > transport targets", () => {
	it("builds the list conditionally, as the Adonis config does", () => {
		const inProduction = false;
		const list = targets()
			.pushIf(!inProduction, targets.pretty())
			.pushIf(inProduction, targets.file({ destination: 1 }))
			.toArray();
		expect(list).toEqual([{ target: "pino-pretty", options: {} }]);
	});

	it("skips the factory form of a target it will not use", () => {
		const build = vi.fn(() => targets.pretty());
		targets().pushIf(false, build).toArray();
		expect(build).not.toHaveBeenCalled();
	});

	it("pushUnless is the inverse of pushIf", () => {
		expect(targets().pushUnless(true, targets.pretty()).toArray()).toEqual([]);
		expect(
			targets().pushUnless(false, targets.pretty()).toArray(),
		).toHaveLength(1);
	});

	it("carries a per-target level", () => {
		expect(targets.file({ destination: "/tmp/app.log" }, "warn")).toEqual({
			target: "pino/file",
			options: { destination: "/tmp/app.log" },
			level: "warn",
		});
	});

	it("maps pretty to the human console and a path to a file", () => {
		const [pretty, file] = channelsFromTargets([
			targets.pretty(),
			targets.file({ destination: "/tmp/app.log" }),
		]);
		expect(pretty).toBeInstanceOf(ConsoleChannel);
		expect(file).toBeInstanceOf(FileChannel);
	});

	it("treats a file descriptor as the process output, as JSON", () => {
		const [channel] = channelsFromTargets([targets.file({ destination: 1 })]);
		expect(channel).toBeInstanceOf(ConsoleChannel);
		expect(channel?.name).toBe("console");
	});

	it("actually writes through a transport-declared target", () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const logger = new Logger({
			enabled: true,
			level: "info",
			transport: { targets: [targets.file({ destination: 1 })] },
		});
		logger.info("hello");
		expect(write).toHaveBeenCalled();
		expect(String(write.mock.calls[0]?.[0])).toContain("hello");
		write.mockRestore();
	});

	it("lets an explicit channels list win over transport", () => {
		const written: string[] = [];
		const spy = {
			name: "spy",
			write: (e: { message: string }) => written.push(e.message),
		};
		const logger = new Logger({
			enabled: true,
			level: "info",
			channels: [spy],
			transport: { targets: [targets.pretty()] },
		});
		logger.info("only once");
		expect(written).toEqual(["only once"]);
	});
});
