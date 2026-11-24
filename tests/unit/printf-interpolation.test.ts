import { describe, expect, it } from "vitest";
import { defineConfig } from "../../src/config.js";
import { formatMessage } from "../../src/format.js";
import { jsonLine } from "../../src/jsonLine.js";
import { Logger } from "../../src/Logger.js";
import { LoggerManager } from "../../src/LoggerManager.js";
import type { LogChannel, LogConfig, LogEntry } from "../../src/types.js";

/** The redaction `ream configure @c9up/spectrum` writes. */
const GENERATED_PATHS = [
	"req.headers.authorization",
	"req.headers.cookie",
	'res.headers["set-cookie"]',
];

function capture(): { channel: LogChannel; lines: string[] } {
	const lines: string[] = [];
	return {
		lines,
		channel: {
			name: "capture",
			write: (entry: LogEntry) => void lines.push(jsonLine(entry)),
		},
	};
}

function logger(config: Partial<LogConfig> = {}): {
	log: Logger;
	lines: string[];
} {
	const { channel, lines } = capture();
	const log = new Logger({
		level: "info",
		channels: [channel],
		redact: { paths: GENERATED_PATHS },
		...config,
	});
	return { log, lines };
}

function parsed(lines: string[], index = 0): Record<string, unknown> {
	const line = lines[index];
	if (line === undefined) throw new Error(`no line ${index}`);
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null) throw new Error(line);
	return { ...value };
}

function requestView(): Record<string, unknown> {
	return {
		method: "POST",
		url: "/login",
		headers: {
			authorization: "Bearer s3cr3t-token",
			cookie: "ream-session=SESSIONID123",
		},
	};
}

describe("message-first call with one object: the object is always fields", () => {
	// Reached the way ream reaches it: manager -> child -> message-first.
	function contextLogger(): {
		ctxLogger: Logger;
		lines: string[];
	} {
		const { channel, lines } = capture();
		const manager = new LoggerManager(
			defineConfig({
				default: "app",
				loggers: {
					app: {
						level: "info",
						redact: { paths: GENERATED_PATHS },
						channels: [channel],
					},
				},
			}),
		);
		return { lines, ctxLogger: manager.child({ correlationId: "req-1" }) };
	}

	for (const token of ["%j", "%o", "%O", "%s", "%%", "%c", "%d", "%i", "%f"]) {
		it(`a ${token} in the message leaves the fields structured and redacted`, () => {
			const { ctxLogger, lines } = contextLogger();
			const email = `x${token}@example.com`;
			ctxLogger.warn(`login failed for ${email}`, {
				req: requestView(),
				ip: "10.0.0.1",
			});
			const line = lines[0] ?? "";
			expect(line).not.toContain("s3cr3t-token");
			expect(line).not.toContain("SESSIONID123");
			const entry = parsed(lines);
			expect(entry.msg).toBe(`login failed for ${email}`);
			expect(entry.ip).toBe("10.0.0.1");
			expect(entry.req).toEqual({
				method: "POST",
				url: "/login",
				headers: { authorization: "[Redacted]", cookie: "[Redacted]" },
			});
		});
	}

	it("a single Error is written under the error key, not appended to the message", () => {
		const { log, lines } = logger({ errorKey: "error" });
		log.error("save failed %s", new Error("boom"));
		const entry = parsed(lines);
		expect(entry.msg).toBe("save failed %s");
		expect(entry.error).toMatchObject({ type: "Error", message: "boom" });
	});
});

describe("printf interpolation follows the upstream formatter", () => {
	it("an object interpolated by %j, %o or %O is redacted with the configured paths", () => {
		for (const token of ["%j", "%o", "%O"]) {
			const { log, lines } = logger();
			log.info(`request ${token} from %s`, { req: requestView() }, "10.0.0.1");
			const message = String(parsed(lines).msg);
			expect(message).not.toContain("s3cr3t-token");
			expect(message).not.toContain("SESSIONID123");
			expect(message).toBe(
				'request {"req":{"method":"POST","url":"/login","headers":{"authorization":"[Redacted]","cookie":"[Redacted]"}}} from 10.0.0.1',
			);
		}
	});

	it("an interpolated object goes through the serializers too", () => {
		const { log, lines } = logger({
			serializers: { user: () => ({ id: 7 }) },
		});
		log.info("as %j and %j", { user: { id: 7, password: "pw" } }, 2);
		expect(parsed(lines).msg).toBe('as {"user":{"id":7}} and 2');
	});

	it("an interpolated Error is serialised like an err field", () => {
		const { log, lines } = logger();
		const err = Object.assign(new Error("boom"), { code: "E_X" });
		log.info("failed: %j %s", err, "now");
		const message = String(parsed(lines).msg);
		expect(message).toContain('"type":"Error"');
		expect(message).toContain('"code":"E_X"');
		expect(message).toContain('"message":"boom"');
	});

	it("object-first and error-first calls redact what their message interpolates", () => {
		const { log, lines } = logger();
		log.info({ userId: 1 }, "seen %j %s", { req: requestView() }, "x");
		log.error(new Error("boom"), "seen %o %s", { req: requestView() }, "y");
		for (const index of [0, 1]) {
			expect(lines[index]).not.toContain("s3cr3t-token");
			expect(String(parsed(lines, index).msg)).toContain("[Redacted]");
		}
		expect(parsed(lines).userId).toBe(1);
	});

	it("%s does not inspect an object, and arguments no token takes are dropped", () => {
		const { log, lines } = logger();
		log.info("token %s", { token: "reset-tok-123" }, "extra", { more: 1 });
		log.info("no token at all", "a", "b");
		expect(parsed(lines).msg).toBe("token [object Object]");
		expect(parsed(lines, 1).msg).toBe("no token at all");
		expect(lines.join("\n")).not.toContain("reset-tok-123");
	});

	it("a circular interpolated object is written, not thrown", () => {
		const { log, lines } = logger();
		const node: Record<string, unknown> = { name: "n" };
		node.self = node;
		log.info("graph %j %s", node, "end");
		expect(parsed(lines).msg).toBe(
			'graph {"name":"n","self":"[Circular]"} end',
		);
	});
});

describe("formatMessage", () => {
	const json = (value: unknown): string => JSON.stringify(value) ?? "undefined";

	it("replaces each token by its rule", () => {
		expect(formatMessage("%s %d %i %f", ["a", "4.5", 4.9, "1.5"], json)).toBe(
			"a 4.5 4 1.5",
		);
		expect(formatMessage("%j and %o", ["text", () => 1], json)).toBe(
			"'text' and <anonymous>",
		);
		function named(): void {}
		expect(formatMessage("%O", [named], json)).toBe("named");
	});

	it("keeps the template as written when there is nothing to interpolate", () => {
		expect(formatMessage("100%% %s", [], json)).toBe("100%% %s");
		expect(formatMessage("no token", [1, 2], json)).toBe("no token");
		expect(formatMessage("trailing %", [1], json)).toBe("trailing %");
	});

	it("writes %% as one percent sign that takes no argument", () => {
		expect(formatMessage("100%% of %s", ["x"], json)).toBe("100% of x");
	});

	it("leaves %c and unknown tokens as written, and a null number token too", () => {
		expect(formatMessage("a%cb %s", ["x", "y"], json)).toBe("a%cb y");
		expect(formatMessage("n=%d", [null], json)).toBe("n=%d");
		expect(formatMessage("j=%j", [undefined], json)).toBe("j=%j");
		expect(formatMessage("%s %s", ["only"], json)).toBe("only %s");
	});

	it("survives a value with no string or number form", () => {
		const bare = Object.create(null);
		expect(formatMessage("%s|%d|%i", [bare, Symbol("s"), bare], json)).toBe(
			"[unprintable]|NaN|NaN",
		);
	});
});
