/**
 * A logger writes a line with no idea which request caused it.
 *
 * The registry here is what lets something outside spectrum — the framework's
 * debug toolbar, a test — see the line anyway, and the provider is what puts
 * it on the application's emitter. Both are the arrangement atlas already uses
 * for `db:query`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { clearLogListeners, onLog } from "../../src/events.js";
import { Logger } from "../../src/Logger.js";
import SpectrumProvider, {
	type SpectrumAppContext,
} from "../../src/SpectrumProvider.js";
import type { LogChannel, LogEntry } from "../../src/types.js";
import { makeApp as baseApp, resolveLogger } from "../helpers/app.js";

class TestChannel implements LogChannel {
	name = "test";
	entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

/** A container that also holds an emitter, as an application's does. */
function makeApp(emitter?: unknown): SpectrumAppContext {
	return baseApp(
		{
			default: "app",
			loggers: { app: { level: "info", channels: [new TestChannel()] } },
		},
		new Map(emitter === undefined ? [] : [["events", emitter]]),
	);
}

describe("spectrum > log observers", () => {
	afterEach(() => {
		clearLogListeners();
	});

	it("hands a listener the line a channel would see", () => {
		const seen: LogEntry[] = [];
		onLog((entry) => seen.push(entry));

		new Logger({ level: "info", channels: [] }).info("hello", { userId: 7 });

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			level: "info",
			message: "hello",
			userId: 7,
		});
	});

	it("hands it the redacted value, not the raw one", () => {
		// A listener that saw through the redaction would be a way around it.
		const seen: LogEntry[] = [];
		onLog((entry) => seen.push(entry));

		new Logger({ level: "info", channels: [], redact: ["password"] }).info(
			"in",
			{
				password: "hunter2",
			},
		);

		expect(JSON.stringify(seen[0])).not.toContain("hunter2");
	});

	it("does not emit what the level discarded", () => {
		const seen: LogEntry[] = [];
		onLog((entry) => seen.push(entry));

		new Logger({ level: "warn", channels: [] }).debug("quiet");

		expect(seen).toHaveLength(0);
	});

	it("keeps writing when a listener throws", () => {
		const channel = new TestChannel();
		onLog(() => {
			throw new Error("observer is broken");
		});

		new Logger({ level: "info", channels: [channel] }).info("still written");

		// Observability must never change behaviour, least of all the behaviour
		// of writing a log.
		expect(channel.entries).toHaveLength(1);
	});

	it("unsubscribes", () => {
		const seen: LogEntry[] = [];
		const off = onLog((entry) => seen.push(entry));
		off();

		new Logger({ level: "info", channels: [] }).info("after");

		expect(seen).toHaveLength(0);
	});

	it("is bridged onto the app emitter as `log:line`", async () => {
		const emitted: Array<[string, unknown]> = [];
		const app = makeApp({
			emit: (event: string, payload: unknown) => emitted.push([event, payload]),
		});
		const provider = new SpectrumProvider(app);
		provider.register();
		await provider.boot();

		const logger = await resolveLogger(app);
		logger.info("bridged");

		expect(emitted).toContainEqual([
			"log:line",
			expect.objectContaining({ message: "bridged" }),
		]);
	});

	it("stops bridging on shutdown", async () => {
		const emitted: unknown[] = [];
		const app = makeApp({
			emit: (_e: string, payload: unknown) => emitted.push(payload),
		});
		const provider = new SpectrumProvider(app);
		provider.register();
		await provider.boot();
		const logger = await resolveLogger(app);
		await provider.shutdown();

		logger.info("after shutdown");

		// The emitter outlives the provider; a bridge left behind would keep
		// feeding a logger that is no longer ours.
		expect(emitted).toHaveLength(0);
	});

	it("boots without an emitter", async () => {
		const provider = new SpectrumProvider(makeApp());
		provider.register();

		await expect(provider.boot()).resolves.toBeUndefined();
	});
});
