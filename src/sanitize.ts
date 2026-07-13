/**
 * Escape log-forging characters (CR/LF) and ANSI escape sequences so an
 * attacker-controlled value (a channel name, a message, an error string) can
 * neither inject extra log lines nor emit terminal escapes. Shared by
 * `ConsoleChannel` and `Logger`'s channel-failure fallback so both paths get
 * the same protection.
 */
export function sanitizeLogValue(str: string): string {
	// ESC (0x1B) is a control char — match via fromCharCode, not a /\x1b/ regex
	// (Biome's noControlCharactersInRegex rightly flags the literal form).
	const ESC = String.fromCharCode(0x1b);
	return str
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replaceAll(ESC, "[ESC]");
}
