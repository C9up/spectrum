/**
 * Spectrum Logger — structured logging with levels and correlation ID.
 *
 * @implements FR54, FR55, FR56, FR58
 */

import type { LogConfig, LogEntry, LogLevel } from "./types.js";
import { LOG_LEVEL_ORDER } from "./types.js";

export type { LogLevel };

export class Logger {
	private config: LogConfig;
	private module: string;
	private correlationId?: string;

	constructor(config: LogConfig, module = "app", correlationId?: string) {
		this.config = config;
		this.module = module;
		this.correlationId = correlationId;
	}

	/**
	 * Create a child logger scoped to a module and/or correlation ID.
	 * This is the preferred way to set correlation ID — creates an immutable copy.
	 */
	child(options: { module?: string; correlationId?: string }): Logger {
		return new Logger(
			this.config,
			options.module ?? this.module,
			options.correlationId ?? this.correlationId,
		);
	}

	/**
	 * Set the correlation ID on THIS instance.
	 * Prefer child() for per-request scoping to avoid shared-state mutation.
	 */
	setCorrelationId(id: string): void {
		this.correlationId = id;
	}

	trace(message: string, data?: Record<string, unknown>): void {
		this.log("trace", message, data);
	}

	debug(message: string, data?: Record<string, unknown>): void {
		this.log("debug", message, data);
	}

	info(message: string, data?: Record<string, unknown>): void {
		this.log("info", message, data);
	}

	warn(message: string, data?: Record<string, unknown>): void {
		this.log("warn", message, data);
	}

	error(message: string, data?: Record<string, unknown>): void {
		this.log("error", message, data);
	}

	fatal(message: string, data?: Record<string, unknown>): void {
		this.log("fatal", message, data);
	}

	private log(
		level: LogLevel,
		message: string,
		data?: Record<string, unknown>,
	): void {
		const rawEffective =
			this.config.modules?.[this.module] ?? this.config.level;
		const effectiveLevel: LogLevel =
			LOG_LEVEL_ORDER[rawEffective] !== undefined ? rawEffective : "info";
		if ((LOG_LEVEL_ORDER[level] ?? 0) < LOG_LEVEL_ORDER[effectiveLevel]) {
			return;
		}

		const entry: LogEntry = {
			level,
			message,
			module: this.module,
			correlationId: this.correlationId,
			timestamp: new Date().toISOString(),
			data,
		};

		for (const channel of this.config.channels) {
			try {
				channel.write(entry);
			} catch (err) {
				process.stderr.write(
					`[Spectrum] Channel '${channel.name}' failed for: ${message} — ${String(err)}\n`,
				);
			}
		}
	}
}
