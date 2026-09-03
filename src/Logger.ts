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
import { parseRedactPath, redactPath } from "./redact.js";
import { sanitizeLogValue } from "./sanitize.js";
import { channelsFromTargets } from "./targets.js";
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

/** How far down a `cause` chain to follow before calling it a cycle. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Serialize an Error the way pino's `err` serializer does. Non-Error values
 * pass through untouched.
 *
 * `{ name, message, stack }` threw away everything the error was carrying.
 * `err.code` is usually the one field a log search is keyed on, and the `cause`
 * of a wrapped error is the half that says what actually failed — both were
 * dropped, silently, by a serializer whose job is to keep them.
 */
function serializeError(value: unknown, depth = 0): unknown {
	if (!(value instanceof Error)) return value;

	// Own ENUMERABLE properties only, which on an Error means the ones it was
	// given: `message`, `stack` and `name` are not among them.
	const out: Record<string, unknown> = { ...value };
	for (const [key, nested] of Object.entries(out)) {
		if (nested instanceof Error && depth < MAX_CAUSE_DEPTH) {
			out[key] = serializeError(nested, depth + 1);
		}
	}

	// Upstream reads the constructor rather than `name`, so a subclass that
	// never assigns `this.name` is still reported as itself, and it names the
	// field `type` — which is what an Adonis log pipeline reads.
	out.type =
		typeof value.constructor === "function"
			? value.constructor.name
			: value.name;
	out.message = value.message;
	out.stack = value.stack;
	if (value instanceof AggregateError && Array.isArray(value.errors)) {
		out.aggregateErrors = value.errors.map((each) =>
			depth < MAX_CAUSE_DEPTH ? serializeError(each, depth + 1) : String(each),
		);
	}
	if (value.cause !== undefined) {
		out.cause =
			depth < MAX_CAUSE_DEPTH
				? serializeError(value.cause, depth + 1)
				: "[cause chain too deep]";
	}
	return out;
}

const DEFAULT_SERIALIZERS: Record<string, LogSerializer> = {
	err: serializeError,
	error: serializeError,
};

export class Logger {
	#config: LogConfig;
	#module: string;
	#correlationId?: string;
	#bindings: Record<string, unknown>;
	/**
	 * This instance's level, when it has been set on the instance.
	 *
	 * The config object is shared by reference with the parent, every sibling
	 * child and the manager, so writing the level into it made
	 * `child.level = 'debug'` turn on debug for the whole application. pino
	 * keeps the level on the logger; so does this.
	 */
	#level?: LogLevelWithSilent;
	/** `config.redact` compiled once, as pino compiles its redactor once. */
	readonly #redactPaths: string[][];

	constructor(
		config: LogConfig,
		module = "app",
		correlationId?: string,
		bindings: Record<string, unknown> = {},
	) {
		// A migrated config declares `transport.targets`; spectrum writes through
		// channels. Convert once here so every read path downstream sees only
		// channels — an explicit `channels` list wins, since it is the more
		// specific statement of intent.
		this.#config =
			config.channels === undefined && config.transport?.targets !== undefined
				? {
						...config,
						channels: channelsFromTargets(
							config.transport.targets,
							config.level,
						),
					}
				: config;
		this.#module = module;
		this.#correlationId = correlationId;
		this.#bindings = bindings;
		const redact = this.#config.redact;
		const paths =
			redact === undefined ? [] : Array.isArray(redact) ? redact : redact.paths;
		this.#redactPaths = paths.map(parseRedactPath);
	}

	/** Whether the logger is enabled. When false every log call is a no-op. */
	get isEnabled(): boolean {
		return this.#config.enabled !== false;
	}

	/** The level this logger is at. */
	get level(): LogLevelWithSilent {
		return this.#level ?? this.#config.level ?? "info";
	}

	set level(level: LogLevelWithSilent) {
		this.#level = level;
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
	 *
	 * An async callback's promise is HANDED BACK, as upstream hands it back.
	 * Swallowing it turned a rejection inside the guarded block into an
	 * unhandled rejection with no caller able to await it.
	 */
	ifLevelEnabled(
		level: LogLevel,
		callback: (logger: this) => Promise<void>,
	): Promise<void> | undefined;
	ifLevelEnabled(level: LogLevel, callback: (logger: this) => void): void;
	ifLevelEnabled(
		level: LogLevel,
		callback: (logger: this) => unknown,
	): unknown {
		if (this.isLevelEnabled(level)) return callback(this);
		return undefined;
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
		const child = new Logger(this.#config, nextModule, nextCorrelation, {
			...this.#bindings,
			...rest,
		});
		// A child starts where its parent stands now, and moves on its own
		// afterwards — pino's semantics, and the reason the level cannot live
		// in the config the two of them share.
		if (this.#level !== undefined) child.level = this.#level;
		return child;
	}

	/** Current bindings (logger name + child bindings + module/correlationId). */
	bindings(): Record<string, unknown> {
		const out: Record<string, unknown> = {
			...(this.#config.name !== undefined ? { name: this.#config.name } : {}),
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

	/**
	 * No-op — the `silent` level exists so a call site can be written and stay
	 * written. It takes the same arguments as every other level, because
	 * upstream's does and switching a call to it must not stop compiling.
	 */
	silent(mergingObject: unknown, message?: string, ...values: unknown[]): void;
	silent(message: string, ...values: unknown[]): void;
	silent(): void {}

	/** Resolve the numeric threshold for this logger + module. */
	#threshold(): number {
		const raw = this.#config.modules?.[this.#module] ?? this.level;
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
		if (this.#redactPaths.length === 0) return bag;
		const redact = this.#config.redact;
		const censor =
			redact === undefined || Array.isArray(redact)
				? "[Redacted]"
				: (redact.censor ?? "[Redacted]");
		let out: unknown = bag;
		for (const tokens of this.#redactPaths) {
			out = redactPath(out, tokens, censor);
		}
		return isMergeableObject(out) ? out : bag;
	}

	#write(level: LogLevel, arg0: unknown, rest: unknown[]): void {
		if (!this.isEnabled) return;
		if (LOG_LEVEL_ORDER[level] < this.#threshold()) return;

		const { message, mergingObject } = this.#resolveArgs(arg0, rest);

		let bag: Record<string, unknown> = {
			// The name a multi-logger config gave this logger. It was assigned by
			// the manager and then read by nothing, so two loggers writing to the
			// same destination produced lines with no way to tell them apart.
			// pino carries it as a binding; a merging object still wins over it.
			...(this.#config.name !== undefined ? { name: this.#config.name } : {}),
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
