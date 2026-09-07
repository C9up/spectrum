import "./augmentations.js";
import { ConsoleChannel } from "./channels/ConsoleChannel.js";
import { Logger } from "./Logger.js";
import { LoggerManager } from "./LoggerManager.js";
import { clearLogger, getLogger, setLogger } from "./services/main.js";
import { channelsFromTargets } from "./targets.js";
import type {
	LogChannel,
	LogConfig,
	LoggerManagerConfig,
	LogLevelWithSilent,
} from "./types.js";
import { isLogLevelWithSilent, logLevel } from "./types.js";

/** A channel that owns a resource (e.g. a FileChannel WriteStream) to release on shutdown. */
function hasClose(
	ch: LogChannel,
): ch is LogChannel & { close(): void | Promise<void> } {
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
	resolve<T = unknown>(token: unknown): Promise<T>;
}

interface SpectrumConfigStore {
	get<T = unknown>(key: string): T | undefined;
}

export interface SpectrumAppContext {
	container: SpectrumContainer;
	config: SpectrumConfigStore;
}

export default class SpectrumProvider {
	/** The logger this provider bound, so shutdown only clears its own. */
	#owned: Logger | undefined;

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
		// Namespaced by the package that owns it, the way upstream namespaces
		// `lucid.db`, `auth.manager` and `drive.manager` by theirs. The bare
		// token stays bound beside it: it is what every existing
		// `container.make(...)` asks for, and a token is not worth breaking an
		// application over.
		const logger = (): Promise<Logger> =>
			this.app.container.resolve<Logger>(Logger);
		this.app.container.singleton("spectrum.logger", logger);
		this.app.container.singleton("logger", logger);
	}

	async boot() {
		const logger = await this.app.container.resolve<Logger>(Logger);
		this.#owned = logger;
		setLogger(logger);
	}

	/**
	 * Release channel resources (e.g. FileChannel WriteStreams) on shutdown.
	 *
	 * AWAITED, and all of them: closing a file channel ends a stream, and ending
	 * one is a request rather than a completion. Firing them and returning let
	 * the shutdown run on to `process.exit` with the last lines still buffered.
	 * `allSettled` so one channel failing to close does not strand the others.
	 */
	async shutdown() {
		// Release the module-level singleton first, while it is still ours: past
		// this point the channels are closing, and a logger reachable through
		// `services/main` would be writing into streams that have ended.
		if (this.#owned !== undefined && getLogger() === this.#owned) clearLogger();
		this.#owned = undefined;
		const results = await Promise.allSettled(
			this.#channels
				.filter((channel) => hasClose(channel))
				.map(async (channel) => channel.close()),
		);
		// `allSettled` keeps one failure from stranding the others — that is why
		// it is here — but the results were then thrown away. A channel that
		// could not flush is lost log, and losing it silently during shutdown is
		// how the lines explaining the shutdown disappear. Reported to stderr
		// because the logger is exactly what has just been taken down.
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		for (const failure of failures) {
			const reason =
				failure.reason instanceof Error
					? failure.reason.message
					: String(failure.reason);
			process.stderr.write(
				`[spectrum] a channel failed to close; log written just before shutdown may be missing: ${reason}\n`,
			);
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
		const level = isLogLevelWithSilent(cfg.level)
			? cfg.level
			: logLevel(process.env.LOG_LEVEL);
		// An AdonisJS `config/logger.ts` declares its output as
		// `transport.targets`, not as channels. It has to be converted HERE:
		// filling `channels` in with the console fallback below is what stopped
		// the Logger's own conversion from ever running (it only fires when
		// `channels` is absent), so a config that declared a file target reached
		// production writing to a console and nothing to the file it named.
		const channels = this.#channelsFor(cfg, level);
		return { ...cfg, level, channels };
	}

	/** Explicit channels, else the declared targets, else a pretty console. */
	#channelsFor(
		cfg: Partial<LogConfig>,
		level: LogLevelWithSilent,
	): LogChannel[] {
		if (cfg.channels && cfg.channels.length > 0) return cfg.channels;
		const declared = cfg.transport?.targets;
		if (declared && declared.length > 0) {
			return channelsFromTargets(declared, level);
		}
		return [new ConsoleChannel("pretty")];
	}
}
