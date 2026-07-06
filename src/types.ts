/**
 * Spectrum types.
 * @implements FR54, FR57
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** A configured level, including pino's `silent` (disables all output). */
export type LogLevelWithSilent = LogLevel | "silent";

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
	fatal: 5,
};

/** Threshold for the `silent` level — nothing is ever above it. */
export const SILENT_THRESHOLD = Number.POSITIVE_INFINITY;

/** Numeric threshold for a configured level (`silent` → +Infinity). */
export function levelThreshold(level: LogLevelWithSilent): number {
	return level === "silent" ? SILENT_THRESHOLD : LOG_LEVEL_ORDER[level];
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
	/** Turn the logger off while keeping its API callable (no-op). Default: true. */
	enabled?: boolean;
	/** Optional logger name (assigned by the manager when omitted). */
	name?: string;
	level?: LogLevelWithSilent;
	/** Output channels — spectrum divergence from pino transports/destination. */
	channels?: LogChannel[];
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
