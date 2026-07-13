import { ConsoleChannel } from "./channels/ConsoleChannel.js";
import { Logger } from "./Logger.js";
import { LoggerManager } from "./LoggerManager.js";
import { setLogger } from "./services/main.js";
import type {
	LogChannel,
	LogConfig,
	LoggerManagerConfig,
	LogLevelWithSilent,
} from "./types.js";
import { LOG_LEVEL_ORDER } from "./types.js";

const VALID_LEVELS = new Set<string>([
	...Object.keys(LOG_LEVEL_ORDER),
	"silent",
]);

function isValidLevel(raw: unknown): raw is LogLevelWithSilent {
	return typeof raw === "string" && VALID_LEVELS.has(raw);
}

function resolveLogLevel(raw: unknown): LogLevelWithSilent {
	return isValidLevel(raw) ? raw : "info";
}

/** A channel that owns a resource (e.g. a FileChannel WriteStream) to release on shutdown. */
function hasClose(ch: LogChannel): ch is LogChannel & { close(): void } {
	return "close" in ch && typeof ch.close === "function";
}

function isManagerConfig(value: unknown): value is LoggerManagerConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		"loggers" in value &&
		"default" in value
	);
}

function isPartialLogConfig(value: unknown): value is Partial<LogConfig> {
	return typeof value === "object" && value !== null;
}

interface SpectrumContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): T;
}

interface SpectrumConfigStore {
	get<T = unknown>(key: string): T | undefined;
}

export interface SpectrumAppContext {
	container: SpectrumContainer;
	config: SpectrumConfigStore;
}

export default class SpectrumProvider {
	#channels: LogChannel[] = [];

	constructor(protected app: SpectrumAppContext) {}

	register() {
		const raw = this.app.config.get<unknown>("logger");
		const managerConfig = this.#normalize(raw);

		// Collect every channel across all loggers so shutdown can release them.
		this.#channels = Object.values(managerConfig.loggers).flatMap(
			(logger) => logger.channels ?? [],
		);

		const manager = new LoggerManager(managerConfig);
		this.app.container.singleton(Logger, () => manager);
		this.app.container.singleton("logger", () => {
			return this.app.container.resolve<Logger>(Logger);
		});
	}

	async boot() {
		setLogger(this.app.container.resolve<Logger>(Logger));
	}

	/** Release channel resources (e.g. FileChannel WriteStreams) on shutdown. */
	async shutdown() {
		for (const channel of this.#channels) {
			if (hasClose(channel)) channel.close();
		}
	}

	/**
	 * Normalize the raw `logger` config into a multi-logger config, filling in
	 * env-based level fallback and a default console channel. Accepts the Adonis
	 * multi-logger shape or the legacy flat shape (or nothing).
	 */
	#normalize(raw: unknown): LoggerManagerConfig {
		if (isManagerConfig(raw)) {
			const loggers: Record<string, LogConfig> = {};
			for (const [name, cfg] of Object.entries(raw.loggers)) {
				loggers[name] = this.#normalizeLogger(cfg);
			}
			// Fail loud at boot if `default` references a missing logger — else
			// LoggerManager builds with `loggers[default] === undefined` and crashes
			// with a cryptic TypeError on the first log. Mirrors defineConfig().
			if (!loggers[raw.default]) {
				throw new Error(
					`[spectrum] Missing "loggers.${raw.default}". It is referenced by the "default" logger`,
				);
			}
			return { default: raw.default, loggers };
		}
		const flat = isPartialLogConfig(raw) ? raw : {};
		return { default: "app", loggers: { app: this.#normalizeLogger(flat) } };
	}

	#normalizeLogger(cfg: Partial<LogConfig>): LogConfig {
		// Honour the configured channels; fall back to a pretty console channel
		// only when none are supplied.
		const channels =
			cfg.channels && cfg.channels.length > 0
				? cfg.channels
				: [new ConsoleChannel("pretty")];
		const level = isValidLevel(cfg.level)
			? cfg.level
			: resolveLogLevel(process.env.LOG_LEVEL);
		return { ...cfg, level, channels };
	}
}
