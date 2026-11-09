import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleChannel } from "../../src/channels/ConsoleChannel.js";
import { sanitizeLogValue } from "../../src/sanitize.js";
import type { LogEntry } from "../../src/types.js";

const ch = (code: number): string => String.fromCharCode(code);

/** Every code point a terminal or a line-splitting viewer acts on. */
const HOSTILE: Array<[string, number]> = [
	["NUL", 0x00],
	["BEL", 0x07],
	["backspace", 0x08],
	["vertical tab", 0x0b],
	["form feed", 0x0c],
	["DEL", 0x7f],
	["NEL", 0x85],
	["8-bit CSI", 0x9b],
	["8-bit ST", 0x9c],
	["8-bit OSC", 0x9d],
	["line separator", 0x2028],
	["paragraph separator", 0x2029],
];

function unsafeCodePoints(text: string): number[] {
	const found: number[] = [];
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (
			(code < 0x20 && code !== 0x09 && code !== 0x0a) ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x2028 ||
			code === 0x2029
		) {
			found.push(code);
		}
	}
	return found;
}

describe("spectrum > pretty output escapes every control a terminal acts on", () => {
	let stdout: string[];

	beforeEach(() => {
		stdout = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				stdout.push(String(chunk));
				return true;
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function render(over: Partial<LogEntry>): string {
		new ConsoleChannel("pretty").write({
			timestamp: "2026-05-04T12:34:56.000Z",
			level: "info",
			module: "app",
			message: "m",
			...over,
		});
		const out = stdout.join("");
		stdout = [];
		return out;
	}

	for (const [name, code] of HOSTILE) {
		const hostile = `a${ch(code)}b`;
		it(`escapes ${name} in the message, module, correlation id and data`, () => {
			for (const out of [
				render({ message: hostile }),
				render({ module: hostile }),
				render({ correlationId: hostile }),
				render({ name: hostile }),
			]) {
				expect(unsafeCodePoints(out)).toEqual([]);
				expect(out.endsWith("\n")).toBe(true);
				expect(out.indexOf("\n")).toBe(out.length - 1);
			}
		});
	}

	it("writes an escaped control as its code point", () => {
		expect(render({ message: `x${ch(0x9b)}2J` })).toContain("x\\u009b2J");
		expect(render({ name: `y${ch(0x2028)}z` })).toContain("y\\u2028z");
	});

	it("leaves tabs and printable text alone", () => {
		expect(sanitizeLogValue("a\tb é ✓")).toBe("a\tb é ✓");
	});
});
