/**
 * Logger manager — manages multiple named `Logger` instances from a single
 * multi-logger config. Mirrors `@adonisjs/logger`'s `LoggerManager`: extends
 * `Logger` (so the manager itself proxies the default logger), caches created
 * loggers forever, and exposes `use()` / `create()`.
 */

import { Logger } from "./Logger.js";
import type { LogConfig, LoggerManagerConfig } from "./types.js";

export class LoggerManager extends Logger {
	#config: LoggerManagerConfig;
	#loggers: Map<string, Logger> = new Map();

	constructor(config: LoggerManagerConfig) {
		super(config.loggers[config.default]);
		this.#config = config;
	}

	/** Get a named logger (or the default logger when no name is given). */
	use(name?: string): Logger {
		const key = name ?? this.#config.default;

		const cached = this.#loggers.get(key);
		if (cached) return cached;

		const config = this.#config.loggers[key];
		if (!config) {
			throw new Error(
				`[spectrum] Unknown logger "${key}". Registered: ${Object.keys(this.#config.loggers).join(", ")}`,
			);
		}
		if (!config.name) config.name = key;

		const logger = this.create(config);
		this.#loggers.set(key, logger);
		return logger;
	}

	/**
	 * Create a logger from a config. The returned instance is NOT cached or
	 * managed by the manager.
	 */
	create(config: LogConfig): Logger {
		return new Logger(config);
	}
}
