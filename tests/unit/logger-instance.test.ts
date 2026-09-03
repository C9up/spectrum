/**
 * What belongs to one logger instance and what belongs to the config they all
 * share. Getting the line wrong is not visible in a single-logger test: it
 * shows up as one part of an application turning on debug for every other.
 */
import { describe, expect, it } from "vitest";
import { Logger } from "../../src/Logger.js";
import { LoggerManager } from "../../src/LoggerManager.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

class Capture implements LogChannel {
	name = "capture";
	entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

describe("spectrum > setting a level", () => {
	it("moves that logger and leaves its parent where it was", () => {
		const logger = new Logger({ level: "info", channels: [new Capture()] });
		const child = logger.child({ module: "http" });

		child.level = "debug";

		// The config object is shared by reference, so writing the level into it
		// turned one child's debug switch into debug for the whole application.
		expect(child.level).toBe("debug");
		expect(logger.level).toBe("info");
	});

	it("leaves its siblings where they were", () => {
		const logger = new Logger({ level: "info", channels: [new Capture()] });
		const http = logger.child({ module: "http" });
		const jobs = logger.child({ module: "jobs" });

		http.level = "trace";

		expect(jobs.level).toBe("info");
	});

	it("actually changes what that logger writes, and only that logger", () => {
		const channel = new Capture();
		const logger = new Logger({ level: "info", channels: [channel] });
		const child = logger.child({ module: "http" });

		child.level = "debug";
		child.debug("from the child");
		logger.debug("from the parent");

		expect(channel.entries).toHaveLength(1);
		expect(channel.entries[0]?.module).toBe("http");
	});

	it("does not reach back into the manager from a named logger", () => {
		const manager = new LoggerManager({
			default: "app",
			loggers: { app: { level: "info", channels: [new Capture()] } },
		});

		manager.use("app").level = "silent";

		// `use('app')` and the manager are two instances over one config entry.
		// Silencing one used to silence the other.
		expect(manager.level).toBe("info");
	});

	it("hands a child the level its parent stands at now", () => {
		const logger = new Logger({ level: "info", channels: [new Capture()] });
		logger.level = "warn";

		expect(logger.child({ module: "http" }).level).toBe("warn");
	});
});

describe("spectrum > the logger's name", () => {
	it("reaches the entry a named logger writes", () => {
		const channel = new Capture();
		const manager = new LoggerManager({
			default: "app",
			loggers: {
				app: { level: "info", channels: [channel] },
				audit: { level: "info", channels: [channel] },
			},
		});

		manager.use("app").info("one");
		manager.use("audit").info("two");

		// The manager assigned `config.name` and nothing ever read it, so two
		// loggers writing to the same destination produced lines with no way to
		// tell which of them wrote each.
		expect(channel.entries.map((entry) => entry.name)).toEqual([
			"app",
			"audit",
		]);
	});

	it("is a binding, so a merging object still wins over it", () => {
		const channel = new Capture();
		new Logger({ level: "info", channels: [channel], name: "app" }).info(
			{ name: "explicit" },
			"line",
		);

		expect(channel.entries[0]?.name).toBe("explicit");
	});

	it("is absent when the config never named the logger", () => {
		const channel = new Capture();
		new Logger({ level: "info", channels: [channel] }).info("line");

		expect(Object.hasOwn(channel.entries[0] ?? {}, "name")).toBe(false);
	});
});

describe("spectrum > the err serializer", () => {
	it("keeps the properties the error was given", () => {
		const channel = new Capture();
		const error = Object.assign(new Error("refused"), {
			code: "ECONNREFUSED",
			statusCode: 502,
		});

		new Logger({ level: "info", channels: [channel] }).error(error);

		// `{ name, message, stack }` threw `code` away — usually the one field a
		// log search is keyed on.
		const err = channel.entries[0]?.err;
		expect(err).toMatchObject({
			type: "Error",
			message: "refused",
			code: "ECONNREFUSED",
			statusCode: 502,
		});
	});

	it("names the constructor, not the inherited `name`", () => {
		class NotFound extends Error {}
		const channel = new Capture();

		new Logger({ level: "info", channels: [channel] }).error(
			new NotFound("gone"),
		);

		// `err.name` on a subclass that never assigns it is still "Error"; the
		// constructor is what says which error this was.
		expect(channel.entries[0]?.err).toMatchObject({ type: "NotFound" });
	});

	it("follows the cause chain", () => {
		const channel = new Capture();
		const root = new Error("socket closed");

		new Logger({ level: "info", channels: [channel] }).error(
			new Error("query failed", { cause: root }),
		);

		// The cause is the half that says what actually failed, and it was
		// dropped whole.
		expect(channel.entries[0]?.err).toMatchObject({
			message: "query failed",
			cause: { type: "Error", message: "socket closed" },
		});
	});

	it("stops rather than looping on a cause cycle", () => {
		const channel = new Capture();
		const first = new Error("first");
		const second = new Error("second", { cause: first });
		first.cause = second;

		new Logger({ level: "info", channels: [channel] }).error(second);

		expect(() => JSON.stringify(channel.entries[0])).not.toThrow();
	});

	it("leaves a non-Error alone", () => {
		const channel = new Capture();

		new Logger({ level: "info", channels: [channel] }).info(
			{ err: "just a string" },
			"line",
		);

		expect(channel.entries[0]?.err).toBe("just a string");
	});
});
