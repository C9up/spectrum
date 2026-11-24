import {
	E_SPECTRUM_MISSING_DEFAULT_LOGGER,
	E_SPECTRUM_UNKNOWN_DEFAULT_LOGGER,
} from "./errors.js";
import type { LogConfig, LoggerManagerConfig } from "./types.js";

/**
 * The logger `name` declares, read as an OWN key of `loggers`.
 *
 * NAMED DEVIATION — upstream reads `loggers[name]`, which answers
 * `Object.prototype` for `__proto__` and a function for `constructor` or
 * `toString`. The first then had `name` written onto it — onto every object
 * of the process — and the others built a logger with no channel that wrote
 * nothing. A name that is not declared is unknown, whatever it is spelled.
 */
export function declaredLogger(
	loggers: Record<string, LogConfig>,
	name: string,
): LogConfig | undefined {
	if (!Object.hasOwn(loggers, name)) return undefined;
	const config = loggers[name];
	return typeof config === "object" && config !== null ? config : undefined;
}

/**
 * Define the logger config. Accepts either the Adonis multi-logger shape
 * (`{ default, loggers }`) or the legacy flat shape (`{ level, channels,
 * modules, ... }`), and always returns the normalized multi-logger config.
 * The flat form is wrapped under a single `app` logger for back-compat.
 */
export function defineConfig(config: LogConfig): LoggerManagerConfig;
export function defineConfig(config: LoggerManagerConfig): LoggerManagerConfig;
export function defineConfig(
	config: LogConfig | LoggerManagerConfig,
): LoggerManagerConfig {
	if ("loggers" in config) {
		if (!config.default) {
			throw new E_SPECTRUM_MISSING_DEFAULT_LOGGER();
		}
		if (declaredLogger(config.loggers, config.default) === undefined) {
			throw new E_SPECTRUM_UNKNOWN_DEFAULT_LOGGER([
				`Missing "loggers.${config.default}". It is referenced by the "default" logger`,
			]);
		}
		return config;
	}
	return { default: "app", loggers: { app: config } };
}

export type { LogConfig, LoggerManagerConfig };
