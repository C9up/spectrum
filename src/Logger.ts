/**
 * Spectrum Logger — structured logging with levels and correlation ID.
 *
 * A thin, framework-agnostic wrapper that mirrors the surface of
 * `@adonisjs/logger` (itself a pino wrapper): object-first / message-first
 * calls, printf interpolation, `enabled`, `redact`, `serializers`, and the
 * `level` / `isLevelEnabled` / `child` / `bindings` API.
 *
 * Spectrum divergences from pino (preserved): output goes through
 * `LogChannel[]` instead of pino transports, per-module level overrides live
 * in `config.modules`, and the Rust log bridge feeds the same channels.
 *
 * @implements FR54, FR55, FR56, FR58
 */

import { format } from "node:util";
import { sanitizeLogValue } from "./sanitize.js";
import type {
	LogConfig,
	LogEntry,
	LogLevel,
	LogLevelWithSilent,
	LogSerializer,
} from "./types.js";
import { LOG_LEVEL_ORDER, levelThreshold } from "./types.js";

export type { LogLevel };

/** printf-style tokens understood by `util.format`. */
const PRINTF_TOKEN = /%[sdifjoOc%]/;

function isLogLevel(value: string): value is LogLevel {
	return value in LOG_LEVEL_ORDER;
}

/** A plain object usable as a merging object (excludes arrays and Errors). */
function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Error)
	);
}

/**
 * Serialize an Error into a plain `{ name, message, stack }` — the pino `err`
 * serializer parity. Non-Error values pass through untouched.
 */
function serializeError(value: unknown): unknown {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	return value;
}

const DEFAULT_SERIALIZERS: Record<string, LogSerializer> = {
	err: serializeError,
	error: serializeError,
};

/**
 * Copy-on-write redaction of a single dot-path. Never mutates the input; only
 * the objects along the path are shallow-copied.
 */
function redactPath(
	obj: Record<string, unknown>,
	path: string,
	censor: string,
): Record<string, unknown> {
	const dot = path.indexOf(".");
	const head = dot === -1 ? path : path.slice(0, dot);
	if (!(head in obj)) return obj;

	const copy: Record<string, unknown> = { ...obj };
	if (dot === -1) {
		copy[head] = censor;
	} else {
		const child = copy[head];
		if (isMergeableObject(child)) {
			copy[head] = redactPath(child, path.slice(dot + 1), censor);
		}
	}
	return copy;
}

export class Logger {
	#config: LogConfig;
	#module: string;
	#correlationId?: string;
	#bindings: Record<string, unknown>;

	constructor(
		config: LogConfig,
		module = "app",
		correlationId?: string,
		bindings: Record<string, unknown> = {},
	) {
		this.#config = config;
		this.#module = module;
		this.#correlationId = correlationId;
		this.#bindings = bindings;
	}

	/** Whether the logger is enabled. When false every log call is a no-op. */
	get isEnabled(): boolean {
		return this.#config.enabled !== false;
	}

	/** The configured level for this logger. */
	get level(): LogLevelWithSilent {
		return this.#config.level ?? "info";
	}

	set level(level: LogLevelWithSilent) {
		this.#config.level = level;
	}

	/** Numeric value of the current level (`silent` → +Infinity). */
	get levelNumber(): number {
		return levelThreshold(this.level);
	}

	/** A pino-style mapping of level labels and values. */
	get levels(): {
		values: Record<string, number>;
		labels: Record<number, string>;
	} {
		const labels: Record<number, string> = {};
		for (const [label, value] of Object.entries(LOG_LEVEL_ORDER)) {
			labels[value] = label;
		}
		return { values: { ...LOG_LEVEL_ORDER }, labels };
	}

	/** Whether a given level would be emitted for this logger + module. */
	isLevelEnabled(level: LogLevel): boolean {
		if (!this.isEnabled) return false;
		return LOG_LEVEL_ORDER[level] >= this.#threshold();
	}

	/**
	 * Run `callback` only when `level` is enabled — useful to guard expensive
	 * log-data computation.
	 */
	ifLevelEnabled(level: LogLevel, callback: (logger: this) => void): void {
		if (this.isLevelEnabled(level)) callback(this);
	}

	/**
	 * Create a child logger. Accepts arbitrary bindings that are merged into
	 * every entry; `module` and `correlationId` are honoured as conventions.
	 * This is the preferred way to scope per-request logging.
	 */
	child(bindings: Record<string, unknown> = {}): Logger {
		if (!this.isEnabled) return this;
		const { module, correlationId, ...rest } = bindings;
		const nextModule = typeof module === "string" ? module : this.#module;
		const nextCorrelation =
			typeof correlationId === "string" ? correlationId : this.#correlationId;
		return new Logger(this.#config, nextModule, nextCorrelation, {
			...this.#bindings,
			...rest,
		});
	}

	/** Current bindings (child bindings + module/correlationId conventions). */
	bindings(): Record<string, unknown> {
		const out: Record<string, unknown> = {
			...this.#bindings,
			module: this.#module,
		};
		if (this.#correlationId !== undefined)
			out.correlationId = this.#correlationId;
		return out;
	}

	/**
	 * Set the correlation ID on THIS instance.
	 * Prefer child() for per-request scoping to avoid shared-state mutation.
	 */
	setCorrelationId(id: string): void {
		this.#correlationId = id;
	}

	log(
		level: LogLevel,
		mergingObject: unknown,
		message?: string,
		...values: unknown[]
	): void;
	log(level: LogLevel, message: string, ...values: unknown[]): void;
	log(level: LogLevel, arg0: unknown, ...rest: unknown[]): void {
		this.#write(level, arg0, rest);
	}

	trace(mergingObject: unknown, message?: string, ...values: unknown[]): void;
	trace(message: string, ...values: unknown[]): void;
	trace(arg0: unknown, ...rest: unknown[]): void {
		this.#write("trace", arg0, rest);
	}

	debug(mergingObject: unknown, message?: string, ...values: unknown[]): void;
	debug(message: string, ...values: unknown[]): void;
	debug(arg0: unknown, ...rest: unknown[]): void {
		this.#write("debug", arg0, rest);
	}

	info(mergingObject: unknown, message?: string, ...values: unknown[]): void;
	info(message: string, ...values: unknown[]): void;
	info(arg0: unknown, ...rest: unknown[]): void {
		this.#write("info", arg0, rest);
	}

	warn(mergingObject: unknown, message?: string, ...values: unknown[]): void;
	warn(message: string, ...values: unknown[]): void;
	warn(arg0: unknown, ...rest: unknown[]): void {
		this.#write("warn", arg0, rest);
	}

	error(mergingObject: unknown, message?: string, ...values: unknown[]): void;
	error(message: string, ...values: unknown[]): void;
	error(arg0: unknown, ...rest: unknown[]): void {
		this.#write("error", arg0, rest);
	}

	fatal(mergingObject: unknown, message?: string, ...values: unknown[]): void;
	fatal(message: string, ...values: unknown[]): void;
	fatal(arg0: unknown, ...rest: unknown[]): void {
		this.#write("fatal", arg0, rest);
	}

	/** No-op — pino API-surface parity for the `silent` level. */
	silent(): void {}

	/** Resolve the numeric threshold for this logger + module. */
	#threshold(): number {
		const raw = this.#config.modules?.[this.#module] ?? this.#config.level;
		if (raw === "silent") return levelThreshold("silent");
		if (typeof raw === "string" && isLogLevel(raw)) return LOG_LEVEL_ORDER[raw];
		return LOG_LEVEL_ORDER.info;
	}

	/**
	 * Resolve a call's args into a message string and an optional merging object.
	 *
	 * - `(object, message?, ...values)` → object merged at root (pino).
	 * - `(error, message?, ...values)` → `{ err }` merged (pino err serializer).
	 * - `(message, ...values)` → printf via `util.format` (pino).
	 * - `(message, singleObject)` with no printf token → merged as structured
	 *   fields. This is spectrum's message-first ergonomic (ream ContextLogger
	 *   particularity) preserved on top of pino's message-first form.
	 */
	#resolveArgs(
		arg0: unknown,
		rest: unknown[],
	): { message: string; mergingObject?: Record<string, unknown> } {
		if (arg0 instanceof Error) {
			const message =
				typeof rest[0] === "string"
					? format(rest[0], ...rest.slice(1))
					: arg0.message;
			return { message, mergingObject: { err: arg0 } };
		}
		if (isMergeableObject(arg0)) {
			const message =
				typeof rest[0] === "string" ? format(rest[0], ...rest.slice(1)) : "";
			return { message, mergingObject: arg0 };
		}

		const template = typeof arg0 === "string" ? arg0 : String(arg0);
		if (
			rest.length === 1 &&
			isMergeableObject(rest[0]) &&
			!PRINTF_TOKEN.test(template)
		) {
			return { message: template, mergingObject: rest[0] };
		}
		const message = rest.length > 0 ? format(template, ...rest) : template;
		return { message };
	}

	#applySerializers(bag: Record<string, unknown>): Record<string, unknown> {
		const serializers = { ...DEFAULT_SERIALIZERS, ...this.#config.serializers };
		let out: Record<string, unknown> | null = null;
		for (const key of Object.keys(bag)) {
			const serializer = serializers[key];
			if (serializer) {
				if (!out) out = { ...bag };
				out[key] = serializer(bag[key]);
			}
		}
		return out ?? bag;
	}

	#applyRedact(bag: Record<string, unknown>): Record<string, unknown> {
		const redact = this.#config.redact;
		if (!redact) return bag;
		const paths = Array.isArray(redact) ? redact : redact.paths;
		if (paths.length === 0) return bag;
		const censor = Array.isArray(redact)
			? "[Redacted]"
			: (redact.censor ?? "[Redacted]");
		let out = bag;
		for (const path of paths) {
			out = redactPath(out, path, censor);
		}
		return out;
	}

	#write(level: LogLevel, arg0: unknown, rest: unknown[]): void {
		if (!this.isEnabled) return;
		if (LOG_LEVEL_ORDER[level] < this.#threshold()) return;

		const { message, mergingObject } = this.#resolveArgs(arg0, rest);

		let bag: Record<string, unknown> = {
			...this.#bindings,
			...(mergingObject ?? {}),
		};
		bag = this.#applySerializers(bag);
		bag = this.#applyRedact(bag);

		// Structural fields are assigned AFTER the merged bag so a merging object
		// can never overwrite level/module/timestamp (log-injection hardening).
		const entry: LogEntry = {
			...bag,
			level,
			message,
			module: this.#module,
			correlationId: this.#correlationId,
			timestamp: new Date().toISOString(),
		};

		for (const channel of this.#config.channels ?? []) {
			try {
				channel.write(entry);
			} catch (err) {
				// Sanitize every interpolated value — a channel name / message /
				// error carrying CR/LF or ANSI escapes could otherwise forge log
				// lines here (the fallback bypasses the channel's own sanitizer).
				process.stderr.write(
					`[Spectrum] Channel '${sanitizeLogValue(channel.name)}' failed for: ${sanitizeLogValue(
						message,
					)} — ${sanitizeLogValue(String(err))}\n`,
				);
			}
		}
	}
}
