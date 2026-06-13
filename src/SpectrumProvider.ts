import { ConsoleChannel } from "./channels/ConsoleChannel.js";
import { Logger } from "./Logger.js";
import { setLogger } from "./services/main.js";
import type { LogChannel, LogConfig, LogLevel } from "./types.js";
import { LOG_LEVEL_ORDER } from "./types.js";

const VALID_LEVELS = new Set<string>(Object.keys(LOG_LEVEL_ORDER));

function resolveLogLevel(raw: string | undefined): LogLevel {
	if (raw && VALID_LEVELS.has(raw)) return raw as LogLevel;
	return "info";
}

/** A channel that owns a resource (e.g. a FileChannel WriteStream) to release on shutdown. */
function hasClose(ch: LogChannel): ch is LogChannel & { close(): void } {
	return "close" in ch && typeof ch.close === "function";
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
		const config = this.app.config.get<Partial<LogConfig>>("logger");
		const level =
			config?.level && VALID_LEVELS.has(config.level)
				? config.level
				: resolveLogLevel(process.env.LOG_LEVEL);
		// Honour the configured channels (the whole point of LogConfig.channels);
		// fall back to a pretty console channel only when none are supplied.
		// Previously this was hardcoded and config.channels was silently ignored.
		this.#channels =
			config?.channels && config.channels.length > 0
				? config.channels
				: [new ConsoleChannel("pretty")];
		const channels = this.#channels;

		// Forward per-module level overrides (config.logger.modules) — Logger.log
		// gates each module's level off config.modules?.[module]; dropping it here
		// silently disables every per-module override in production.
		const modules = config?.modules;
		this.app.container.singleton(
			Logger,
			() => new Logger({ level, channels, modules }),
		);
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
}
