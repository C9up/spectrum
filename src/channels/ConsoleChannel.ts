/**
 * Console log channel — pretty-print in dev, JSON in prod.
 *
 * @implements FR57, FR58
 */

import type { LogChannel, LogEntry } from "../types.js";

export class ConsoleChannel implements LogChannel {
	name = "console";
	#format: "pretty" | "json";

	constructor(format: "pretty" | "json" = "pretty") {
		this.#format = format;
	}

	write(entry: LogEntry): void {
		if (this.#format === "json") {
			this.#writeJson(entry);
		} else {
			this.#writePretty(entry);
		}
	}

	#writeJson(entry: LogEntry): void {
		// Data nested under 'data' key — no spread to prevent key collisions
		const output = JSON.stringify({
			timestamp: entry.timestamp,
			level: entry.level,
			module: entry.module,
			message: entry.message,
			correlationId: entry.correlationId,
			data: entry.data,
		});
		this.#writeToStream(entry.level, `${output}\n`);
	}

	#sanitize(str: string): string {
		// Strip ANSI escape sequences. ESC (0x1B) is a control char so we match
		// it via String.fromCharCode rather than a /\x1b/ regex (Biome's
		// noControlCharactersInRegex rule rightly flags the literal form).
		const ESC = String.fromCharCode(0x1b);
		return str
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replaceAll(ESC, "[ESC]");
	}

	#writePretty(entry: LogEntry): void {
		const time = entry.timestamp.substring(11, 19); // HH:MM:SS
		const levelStr = entry.level.toUpperCase().padEnd(5);
		const prefix = this.#levelPrefix(entry.level);
		// Sanitize every interpolated piece — `module` is usually
		// developer-controlled but `correlationId` typically flows in from
		// an HTTP header (X-Request-Id / X-Correlation-Id) and can carry
		// attacker-supplied CRLF that would otherwise forge fake log lines.
		const cidRaw = entry.correlationId
			? entry.correlationId.length > 8
				? `${entry.correlationId.substring(0, 8)}…`
				: entry.correlationId
			: "";
		const cid = cidRaw ? ` cid=${this.#sanitize(cidRaw)}` : "";
		const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
		const message = this.#sanitize(entry.message);
		const module = this.#sanitize(entry.module);

		this.#writeToStream(
			entry.level,
			`${prefix} ${time} ${levelStr} [${module}] ${message}${cid}${dataStr}\n`,
		);
	}

	/** Route error/fatal to stderr, others to stdout. */
	#writeToStream(level: string, output: string): void {
		if (level === "error" || level === "fatal") {
			process.stderr.write(output);
		} else {
			process.stdout.write(output);
		}
	}

	#levelPrefix(level: string): string {
		switch (level) {
			case "trace":
				return " ";
			case "debug":
				return " ";
			case "info":
				return "i";
			case "warn":
				return "!";
			case "error":
				return "x";
			case "fatal":
				return "X";
			default:
				return " ";
		}
	}
}
