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
import { SpectrumError } from "./errors.js";
import { emitLog, hasLogListeners } from "./events.js";
import {
	attachLineOptions,
	type JsonLineOptions,
	resolveLineOptions,
} from "./jsonLine.js";
import { type RedactAction, redactPath, redactPathsOf } from "./redact.js";
import { sanitizeLogValue } from "./sanitize.js";
import { serializeError } from "./stdSerializers.js";
import {
	DEFAULT_STRINGIFY_LIMITS,
	isStringifyLimit,
	type StringifyLimits,
} from "./stringify.js";
import { channelsFromConfig } from "./targets.js";
import type {
	ChildOptions,
	LogConfig,
	LogEntry,
	LogLevel,
	LogLevelWithSilent,
	LogSerializer,
} from "./types.js";
import {
	assertLogLevel,
	isLogLevelWithSilent,
	LOG_LEVEL_ORDER,
	levelThreshold,
} from "./types.js";

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

/** The config's stringify limits, checked. */
function stringifyLimits(config: LogConfig): StringifyLimits {
	const { depthLimit, edgeLimit } = config;
	for (const [name, value] of [
		["depthLimit", depthLimit],
		["edgeLimit", edgeLimit],
	] as const) {
		if (value !== undefined && !isStringifyLimit(value)) {
			throw new SpectrumError(
				"E_SPECTRUM_INVALID_STRINGIFY_LIMIT",
				`${name} must be a positive integer, got ${String(value)}`,
			);
		}
	}
	return {
		depthLimit: depthLimit ?? DEFAULT_STRINGIFY_LIMITS.depthLimit,
		edgeLimit: edgeLimit ?? DEFAULT_STRINGIFY_LIMITS.edgeLimit,
	};
}

/** The config's line options, checked; `undefined` when all are default. */
function lineOptions(config: LogConfig): JsonLineOptions | undefined {
	const limits = stringifyLimits(config);
	const { messageKey, timestamp, base, formatters, depthLimit, edgeLimit } =
		config;
	if (
		[messageKey, timestamp, base, formatters, depthLimit, edgeLimit].every(
			(value) => value === undefined,
		)
	) {
		return undefined;
	}
	return resolveLineOptions({
		messageKey,
		timestamp,
		base,
		formatters,
		limits,
	});
}

/**
 * Upstream options spectrum cannot honour. Ignoring them would run the logger
 * as something other than what the config says, so they are refused.
 */
const UNSUPPORTED_OPTIONS = [
	"customLevels",
	"useOnlyCustomLevels",
	"levelComparison",
	"nestedKey",
	"crlf",
] as const;

function rejectUnsupportedOptions(config: LogConfig): void {
	for (const option of UNSUPPORTED_OPTIONS) {
		const value: unknown = Reflect.get(config, option);
		if (value !== undefined) {
			throw new SpectrumError(
				"E_SPECTRUM_UNSUPPORTED_OPTION",
				`the "${option}" logger option is not supported`,
			);
		}
	}
	const streamWrite: unknown =
		config.hooks === undefined
			? undefined
			: Reflect.get(config.hooks, "streamWrite");
	if (streamWrite !== undefined) {
		throw new SpectrumError(
			"E_SPECTRUM_UNSUPPORTED_OPTION",
			'the "hooks.streamWrite" logger option is not supported',
		);
	}
}

/**
 * The config with its output resolved to channels, once: explicit `channels`
 * win, then `destination`, then the transport's targets.
 */
function withChannels(config: LogConfig): LogConfig {
	if (config.channels !== undefined) return config;
	const channels = channelsFromConfig(config, config.level);
	return channels === undefined ? config : { ...config, channels };
}

/** `config.redact`'s censor (or removal), compiled once. */
function redactAction(redact: LogConfig["redact"]): RedactAction {
	if (redact === undefined || Array.isArray(redact)) {
		return { remove: false, censor: () => "[Redacted]" };
	}
	const censor = redact.censor ?? "[Redacted]";
	return {
		remove: redact.remove === true,
		censor: typeof censor === "function" ? censor : () => censor,
	};
}

/**
 * The serializers a key is looked up in, on a null prototype as pino builds
 * its own: every own key of a merging object (a request body, often) is read
 * here, and on an ordinary object `valueOf`, `hasOwnProperty` or `__proto__`
 * answered an `Object.prototype` member — called as a serializer, it threw
 * out of the log call or rewrote the field.
 */
function serializerBag(
	configured: Record<string, LogSerializer> | undefined,
): Record<string, LogSerializer> {
	const bag: Record<string, LogSerializer> = Object.create(null);
	bag.err = serializeError;
	bag.error = serializeError;
	if (configured !== undefined) {
		for (const key of Object.keys(configured)) {
			const serializer = configured[key];
			if (typeof serializer === "function") bag[key] = serializer;
		}
	}
	return bag;
}

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
	readonly #redactAction: RedactAction;
	/**
	 * How a JSON channel writes this logger's lines, when the config moved
	 * anything away from the defaults.
	 */
	readonly #lineOptions: JsonLineOptions | undefined;

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
		rejectUnsupportedOptions(config);
		this.#config = withChannels(config);
		this.#module = module;
		this.#correlationId = correlationId;
		this.#bindings = bindings;
		if (this.#config.level !== undefined) assertLogLevel(this.#config.level);
		for (const value of Object.values(this.#config.modules ?? {})) {
			assertLogLevel(value);
		}
		this.#redactPaths = redactPathsOf(this.#config.redact);
		this.#redactAction = redactAction(this.#config.redact);
		this.#lineOptions = lineOptions(this.#config);
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
		this.#level = assertLogLevel(level);
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
	 *
	 * `options` are upstream's: the child's own `level`, a `redact` that
	 * replaces the parent's, `serializers` added to the parent's, and a
	 * `msgPrefix` appended to the parent's.
	 */
	child(
		bindings: Record<string, unknown> = {},
		options?: ChildOptions,
	): Logger {
		if (!this.isEnabled) return this;
		const { module, correlationId, ...rest } = bindings;
		const nextModule = typeof module === "string" ? module : this.#module;
		const nextCorrelation =
			typeof correlationId === "string" ? correlationId : this.#correlationId;
		const child = new Logger(
			options === undefined ? this.#config : this.#childConfig(options),
			nextModule,
			nextCorrelation,
			{ ...this.#bindings, ...rest },
		);
		// A child starts where its parent stands now, and moves on its own
		// afterwards — pino's semantics, and the reason the level cannot live
		// in the config the two of them share.
		const level = options?.level ?? this.#level;
		if (level !== undefined) child.level = level;
		this.#config.onChild?.(child);
		return child;
	}

	/** The config a child with options writes under; the parent's is untouched. */
	#childConfig(options: ChildOptions): LogConfig {
		return {
			...this.#config,
			...(options.redact !== undefined ? { redact: options.redact } : {}),
			...(options.serializers !== undefined
				? {
						serializers: {
							...this.#config.serializers,
							...options.serializers,
						},
					}
				: {}),
			...(options.msgPrefix !== undefined
				? { msgPrefix: (this.#config.msgPrefix ?? "") + options.msgPrefix }
				: {}),
		};
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

	/**
	 * Resolve the numeric threshold for this logger + module.
	 *
	 * Only an OWN entry of `modules` overrides: bracket access answered for
	 * `constructor`, `toString` or `__proto__` with an inherited function, which
	 * is no level, and the fallback put such a module at `info` under a logger
	 * configured for `error`. Without an override a module is at the logger's
	 * own level — never at one more verbose than configured.
	 */
	#threshold(): number {
		const modules = this.#config.modules;
		const override =
			modules !== undefined && Object.hasOwn(modules, this.#module)
				? modules[this.#module]
				: undefined;
		const raw = isLogLevelWithSilent(override) ? override : this.level;
		if (raw === "silent") return levelThreshold("silent");
		if (isLogLevel(raw)) return LOG_LEVEL_ORDER[raw];
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
		const { message, mergingObject, given } = this.#splitArgs(arg0, rest);
		// The prefix goes on a message the call gave, as upstream's does.
		const prefix = this.#config.msgPrefix;
		return {
			message: prefix !== undefined && given ? prefix + message : message,
			...(mergingObject !== undefined ? { mergingObject } : {}),
		};
	}

	#splitArgs(
		arg0: unknown,
		rest: unknown[],
	): {
		message: string;
		mergingObject?: Record<string, unknown>;
		given: boolean;
	} {
		const errorKey = this.#config.errorKey ?? "err";
		if (arg0 instanceof Error) {
			const message =
				typeof rest[0] === "string"
					? format(rest[0], ...rest.slice(1))
					: arg0.message;
			return { message, mergingObject: { [errorKey]: arg0 }, given: true };
		}
		if (isMergeableObject(arg0)) {
			if (typeof rest[0] === "string") {
				return {
					message: format(rest[0], ...rest.slice(1)),
					mergingObject: arg0,
					given: true,
				};
			}
			// An object carrying an error and no message is described by the
			// error's message, as upstream does.
			const err = Object.hasOwn(arg0, errorKey) ? arg0[errorKey] : undefined;
			return err instanceof Error
				? { message: err.message, mergingObject: arg0, given: true }
				: { message: "", mergingObject: arg0, given: false };
		}

		const template = typeof arg0 === "string" ? arg0 : String(arg0);
		if (
			rest.length === 1 &&
			isMergeableObject(rest[0]) &&
			!PRINTF_TOKEN.test(template)
		) {
			return { message: template, mergingObject: rest[0], given: true };
		}
		const message = rest.length > 0 ? format(template, ...rest) : template;
		return { message, given: true };
	}

	/** The merging object with the mixin's fields; the merging object wins by default. */
	#withMixin(
		mergingObject: Record<string, unknown>,
		level: LogLevel,
	): Record<string, unknown> {
		const mixin = this.#config.mixin;
		if (mixin === undefined) return mergingObject;
		const mixed: unknown = mixin(mergingObject, LOG_LEVEL_ORDER[level], this);
		const mixinObject = isMergeableObject(mixed) ? mixed : {};
		const strategy = this.#config.mixinMergeStrategy;
		return strategy !== undefined
			? strategy(mergingObject, mixinObject)
			: { ...mixinObject, ...mergingObject };
	}

	#applySerializers(bag: Record<string, unknown>): Record<string, unknown> {
		const serializers = serializerBag(this.#config.serializers);
		const errorKey = this.#config.errorKey ?? "err";
		let out: Record<string, unknown> | null = null;
		for (const key of Object.keys(bag)) {
			// The error key takes the `err` serializer unless it has its own.
			const serializer =
				serializers[key] ?? (key === errorKey ? serializers.err : undefined);
			if (serializer !== undefined) {
				if (!out) out = { ...bag };
				out[key] = serializer(bag[key]);
			}
		}
		return out ?? bag;
	}

	#applyRedact(bag: Record<string, unknown>): Record<string, unknown> {
		if (this.#redactPaths.length === 0) return bag;
		let out: unknown = bag;
		for (const tokens of this.#redactPaths) {
			out = redactPath(out, tokens, this.#redactAction);
		}
		return isMergeableObject(out) ? out : bag;
	}

	#write(
		level: LogLevel,
		arg0: unknown,
		rest: unknown[],
		viaHook = false,
	): void {
		if (!this.isEnabled) return;
		if (LOG_LEVEL_ORDER[level] < this.#threshold()) return;

		const hook = this.#config.hooks?.logMethod;
		if (hook !== undefined && !viaHook) {
			hook.call(
				this,
				[arg0, ...rest],
				(...args: unknown[]) =>
					this.#write(level, args[0], args.slice(1), true),
				LOG_LEVEL_ORDER[level],
			);
			return;
		}

		const { message, mergingObject } = this.#resolveArgs(arg0, rest);
		const merged = this.#withMixin(mergingObject ?? {}, level);

		let bag: Record<string, unknown> = {
			// The name a multi-logger config gave this logger. It was assigned by
			// the manager and then read by nothing, so two loggers writing to the
			// same destination produced lines with no way to tell them apart.
			// pino carries it as a binding; a merging object still wins over it.
			...(this.#config.name !== undefined ? { name: this.#config.name } : {}),
			...this.#bindings,
			...merged,
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

		if (this.#lineOptions !== undefined) {
			attachLineOptions(entry, this.#lineOptions);
		}

		// Observers before the channels: a channel that throws falls back to
		// stderr, and an observer must not be skipped by that path.
		if (hasLogListeners()) emitLog(entry);

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
