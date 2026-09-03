import type { TransportTargetOptions } from "./targets.js";
/**
 * Spectrum types.
 * @implements FR54, FR57
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** A configured level, including pino's `silent` (disables all output). */
export type LogLevelWithSilent = LogLevel | "silent";

/**
 * The numeric value of each level, on pino's scale.
 *
 * Only the ORDER matters to the comparisons here, but the numbers are what
 * `logger.levels` and `logger.levelNumber` hand back, and those are read
 * against the ecosystem's values: an `info` line is 30 everywhere upstream
 * reaches, so it is 30 here.
 */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
};

/** Threshold for the `silent` level — nothing is ever above it. */
export const SILENT_THRESHOLD = Number.POSITIVE_INFINITY;

/** Numeric threshold for a configured level (`silent` → +Infinity). */
export function levelThreshold(level: LogLevelWithSilent): number {
	return level === "silent" ? SILENT_THRESHOLD : LOG_LEVEL_ORDER[level];
}

const CONFIGURED_LEVELS = new Set<string>([
	...Object.keys(LOG_LEVEL_ORDER),
	"silent",
]);

/** Whether a value is a level a config may name. */
export function isLogLevelWithSilent(
	value: unknown,
): value is LogLevelWithSilent {
	return typeof value === "string" && CONFIGURED_LEVELS.has(value);
}

/**
 * Narrow an untyped level — `process.env.LOG_LEVEL`, a CLI flag — to one the
 * config can name, falling back to `info`.
 *
 * Without it a config file has to assert the env string into the union, and an
 * assertion is the wrong tool for a value that comes from outside the program:
 * it claims to know what it cannot. This checks.
 */
export function logLevel(
	raw: unknown,
	fallback: LogLevelWithSilent = "info",
): LogLevelWithSilent {
	return isLogLevelWithSilent(raw) ? raw : fallback;
}

export interface LogEntry {
	level: LogLevel;
	message: string;
	module: string;
	correlationId?: string;
	timestamp: string;
	/**
	 * @deprecated Legacy structured payload. New log calls merge fields at the
	 * entry root (pino output parity); this field remains for manually
	 * constructed entries and FakeLogger back-compat.
	 */
	data?: Record<string, unknown>;
	/**
	 * Merging-object + child bindings live at the root of the entry to mirror
	 * pino's flat output shape.
	 */
	[key: string]: unknown;
}

export type { TransportTargetOptions } from "./targets.js";

export interface LogChannel {
	name: string;
	write(entry: LogEntry): void;
}

/** Transforms a value before it is written (pino `serializers` parity). */
export type LogSerializer = (value: unknown) => unknown;

/** Redaction config (pino `redact` parity). */
export interface RedactOptions {
	paths: string[];
	censor?: string;
}

/**
 * Configuration for a single logger. Mirrors the surface of `@adonisjs/logger`
 * / pino, with spectrum divergences called out inline.
 */
export interface LogConfig {
	/**
	 * Turn the logger off while keeping its API callable (no-op). Default: true.
	 *
	 * Named deviation: upstream reads this as `!!config.enabled`, so a config
	 * that never writes it has a logger that silently logs nothing. That only
	 * works because upstream's own generated config always writes `enabled:
	 * true` — a default that turns the feature off is a trap for every config
	 * written by hand.
	 */
	enabled?: boolean;
	/** Optional logger name (assigned by the manager when omitted). */
	name?: string;
	level?: LogLevelWithSilent;
	/** Output channels — spectrum divergence from pino transports/destination. */
	channels?: LogChannel[];
	/**
	 * Transport targets, as an AdonisJS `config/logger.ts` declares them. They
	 * are converted to {@link LogChannel}s at construction, so a migrated config
	 * drives real output instead of being quietly ignored. Explicit `channels`
	 * win when both are given.
	 */
	transport?: { targets?: readonly TransportTargetOptions[] };
	/** Per-module level overrides — spectrum divergence. */
	modules?: Record<string, LogLevelWithSilent>;
	/** Keys / dot-paths to redact on the merging object before writing. */
	redact?: string[] | RedactOptions;
	/** Per-key value serializers (`err`/`error` handled by default). */
	serializers?: Record<string, LogSerializer>;
}

/**
 * Multi-logger config (Adonis `defineConfig` shape): a `default` logger name
 * pointing into a map of named loggers.
 */
export interface LoggerManagerConfig {
	default: string;
	loggers: Record<string, LogConfig>;
}

const RESERVED_ENTRY_KEYS = new Set<string>([
	"level",
	"message",
	"module",
	"correlationId",
	"timestamp",
	"data",
]);

/** Root-level merged fields (everything that is not a structural LogEntry key). */
export function logEntryExtras(entry: LogEntry): Record<string, unknown> {
	const extras: Record<string, unknown> = {};
	for (const key of Object.keys(entry)) {
		if (!RESERVED_ENTRY_KEYS.has(key)) extras[key] = entry[key];
	}
	return extras;
}
