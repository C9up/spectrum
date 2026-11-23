import {
	E_SPECTRUM_MISSING_DEFAULT_LOGGER,
	E_SPECTRUM_UNKNOWN_DEFAULT_LOGGER,
} from "./errors.js";
import type { LogConfig, LoggerManagerConfig } from "./types.js";

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
		if (!config.loggers[config.default]) {
			throw new E_SPECTRUM_UNKNOWN_DEFAULT_LOGGER([
				`Missing "loggers.${config.default}". It is referenced by the "default" logger`,
			]);
		}
		return config;
	}
	return { default: "app", loggers: { app: config } };
}

export type { LogConfig, LoggerManagerConfig };
