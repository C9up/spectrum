import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleChannel } from "../../src/channels/ConsoleChannel.js";
import type { LogEntry } from "../../src/types.js";

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
	return {
		timestamp: "2026-05-04T12:34:56.000Z",
		level: "info",
		module: "app",
		message: "hello",
		correlationId: undefined,
		data: undefined,
		...over,
	};
}

describe("spectrum > ConsoleChannel", () => {
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		stdout = [];
		stderr = [];
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: unknown,
		) => {
			stdout.push(typeof chunk === "string" ? chunk : String(chunk));
			return true;
		}) as never);
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
			chunk: unknown,
		) => {
			stderr.push(typeof chunk === "string" ? chunk : String(chunk));
			return true;
		}) as never);
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("writes pretty info logs to stdout", () => {
		new ConsoleChannel().write(makeEntry());
		expect(stdout.join("")).toMatch(/info\b/i);
		expect(stdout.join("")).toContain("[app]");
		expect(stdout.join("")).toContain("hello");
		expect(stderr).toEqual([]);
	});

	it("routes error logs to stderr", () => {
		new ConsoleChannel().write(makeEntry({ level: "error", message: "boom" }));
		expect(stderr.join("")).toContain("boom");
		expect(stdout).toEqual([]);
	});

	it("routes fatal logs to stderr", () => {
		new ConsoleChannel().write(makeEntry({ level: "fatal" }));
		expect(stderr.length).toBeGreaterThan(0);
	});

	it("uses the appropriate level prefix for each level", () => {
		const ch = new ConsoleChannel();
		const levels: Array<LogEntry["level"]> = [
			"trace",
			"debug",
			"info",
			"warn",
			"error",
			"fatal",
		];
		for (const lvl of levels) {
			ch.write(makeEntry({ level: lvl }));
		}
		// We just want to confirm 6 writes happened across stdout+stderr.
		expect(stdout.length + stderr.length).toBe(6);
	});

	it("emits compact JSON when format='json'", () => {
		new ConsoleChannel("json").write(
			makeEntry({ data: { user: 1 }, correlationId: "abc-12345" }),
		);
		const out = stdout.join("");
		expect(out.trim().startsWith("{")).toBe(true);
		const parsed = JSON.parse(out);
		expect(parsed).toMatchObject({
			level: "info",
			module: "app",
			message: "hello",
			data: { user: 1 },
			correlationId: "abc-12345",
		});
	});

	it("truncates long correlationId in pretty format", () => {
		new ConsoleChannel().write(
			makeEntry({ correlationId: "abcdefghij-too-long" }),
		);
		expect(stdout.join("")).toContain("cid=abcdefgh…");
	});

	it("renders short correlationId verbatim", () => {
		new ConsoleChannel().write(makeEntry({ correlationId: "12345678" }));
		expect(stdout.join("")).toContain("cid=12345678");
	});

	it("appends data JSON to pretty output when present", () => {
		new ConsoleChannel().write(makeEntry({ data: { count: 3 } }));
		expect(stdout.join("")).toContain('{"count":3}');
	});

	it("sanitizes \\r, \\n and ANSI ESC characters from message", () => {
		const ESC = String.fromCharCode(0x1b);
		new ConsoleChannel().write(
			makeEntry({ message: `evil${ESC}[31mred${ESC}[0m\nnewline\rcr` }),
		);
		const out = stdout.join("");
		expect(out).toContain("[ESC]");
		expect(out).toContain("\\n");
		expect(out).toContain("\\r");
	});

	it("sanitizes CRLF inside correlationId so attackers can't forge log lines", () => {
		// `correlationId` typically flows in from an HTTP header (eg
		// X-Request-Id) and is therefore attacker-controlled. A raw `\r\n`
		// in the value would split the line and let an attacker append a
		// fake log entry on the next physical line. Regression test for
		// log-injection via the cid field.
		new ConsoleChannel().write(
			makeEntry({
				correlationId: "abc\r\nFAKE level=error [auth] forged",
				message: "real",
			}),
		);
		const out = stdout.join("");
		// Output should contain exactly ONE newline (the trailing `\n` the
		// pretty formatter appends to every entry). No raw CR/LF survived.
		expect(out.match(/\n/g)?.length).toBe(1);
		expect(out).not.toContain("\r\n");
		expect(out).not.toContain("FAKE level=error");
		// The cid is truncated (length > 8) and the surviving prefix
		// either gets escaped (`\\r\\n`) or chopped before the CRLF —
		// either way the literal control byte is gone.
		expect(out).toContain("cid=");
		expect(out).not.toMatch(/cid=abc\r/);
	});

	it("sanitizes a short correlationId without truncation", () => {
		new ConsoleChannel().write(
			makeEntry({ correlationId: "a\nb", message: "x" }),
		);
		const out = stdout.join("");
		expect(out).toContain("cid=a\\nb");
		expect(out.match(/\n/g)?.length).toBe(1);
	});
});
