/**
 * Console log channel — pretty-print in dev, JSON in prod.
 *
 * @implements FR57, FR58
 */

import { sanitizeLogValue } from "../sanitize.js";
import type { LogChannel, LogEntry } from "../types.js";
import { logEntryExtras } from "../types.js";

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
		// Structural fields first, then merged root fields spread flat (pino
		// output parity). Legacy `data` (if present) stays under its own key.
		const output = JSON.stringify({
			timestamp: entry.timestamp,
			level: entry.level,
			module: entry.module,
			message: entry.message,
			correlationId: entry.correlationId,
			data: entry.data,
			...logEntryExtras(entry),
		});
		this.#writeToStream(entry.level, `${output}\n`);
	}

	#sanitize(str: string): string {
		return sanitizeLogValue(str);
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
		// Prefer legacy `data`; otherwise render the merged root fields. JSON
		// encoding escapes control chars, so no CRLF can leak into the line.
		const extras = logEntryExtras(entry);
		const payload =
			entry.data ?? (Object.keys(extras).length > 0 ? extras : undefined);
		const dataStr = payload ? ` ${JSON.stringify(payload)}` : "";
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
