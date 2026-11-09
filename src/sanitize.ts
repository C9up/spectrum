/**
 * Escape what a terminal or a log viewer would act on, so an
 * attacker-controlled value (a channel name, a message, an error string, a
 * correlation id from a request header) can neither inject extra log lines
 * nor drive the terminal. Shared by `ConsoleChannel` and `Logger`'s
 * channel-failure fallback so both paths get the same protection.
 *
 * Covered: every C0 control but TAB (CR/LF forge lines, BS overwrites what
 * was printed, ESC starts a sequence), DEL, every C1 control (U+009B and
 * U+009D are CSI and OSC on terminals that honour 8-bit controls, so
 * `\u009b2J` clears the screen), and U+2028/U+2029, which viewers treat as
 * line breaks.
 */
export function sanitizeLogValue(str: string): string {
	let out = "";
	let from = 0;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (!isUnsafe(code)) continue;
		out += str.slice(from, i) + escapeCode(code);
		from = i + 1;
	}
	return from === 0 ? str : out + str.slice(from);
}

function isUnsafe(code: number): boolean {
	return (
		(code < 0x20 && code !== 0x09) ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x2028 ||
		code === 0x2029
	);
}

function escapeCode(code: number): string {
	if (code === 0x0d) return "\\r";
	if (code === 0x0a) return "\\n";
	if (code === 0x1b) return "[ESC]";
	return `\\u${code.toString(16).padStart(4, "0")}`;
}
