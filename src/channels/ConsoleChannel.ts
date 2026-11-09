/**
 * Console log channel — pretty-print in dev, JSON in prod.
 *
 * @implements FR57, FR58
 */

import { jsonLine, lineOptionsFor } from "../jsonLine.js";
import { sanitizeLogValue } from "../sanitize.js";
import { stringifyRecord } from "../stringify.js";
import type { LogChannel, LogEntry } from "../types.js";
import { logEntryExtras } from "../types.js";

export interface ConsoleChannelOptions {
	/**
	 * Write every level to this one stream. Without it, error and fatal go to
	 * stderr and the rest to stdout.
	 */
	stream?: "stdout" | "stderr";
}

export class ConsoleChannel implements LogChannel {
	name = "console";
	#format: "pretty" | "json";
	readonly #stream: "stdout" | "stderr" | undefined;

	constructor(
		format: "pretty" | "json" = "pretty",
		options: ConsoleChannelOptions = {},
	) {
		this.#format = format;
		this.#stream = options.stream;
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
		const output = jsonLine(entry);
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
		// escapes C0 controls but not DEL, C1 or U+2028/2029, so the rendered
		// data goes through the same sanitizer as the message.
		const extras = logEntryExtras(entry);
		const payload =
			entry.data ?? (Object.keys(extras).length > 0 ? extras : undefined);
		const dataStr = payload
			? ` ${this.#sanitize(stringifyRecord(payload, lineOptionsFor(entry).limits))}`
			: "";
		const message = this.#sanitize(entry.message);
		const module = this.#sanitize(entry.module);

		this.#writeToStream(
			entry.level,
			`${prefix} ${time} ${levelStr} [${module}] ${message}${cid}${dataStr}\n`,
		);
	}

	/** The configured stream, else error/fatal to stderr and others to stdout. */
	#writeToStream(level: string, output: string): void {
		if (this.#stream === "stdout") {
			process.stdout.write(output);
		} else if (
			this.#stream === "stderr" ||
			level === "error" ||
			level === "fatal"
		) {
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
