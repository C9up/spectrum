/**
 * Transport targets — the shape an AdonisJS `config/logger.ts` is written in:
 *
 *   transport: {
 *     targets: targets()
 *       .pushIf(!app.inProduction, targets.pretty())
 *       .pushIf(app.inProduction, targets.file({ destination: 1 }))
 *       .toArray(),
 *   }
 *
 * Named deviation: upstream targets name pino transports, which run in worker
 * threads. Spectrum writes through its own `LogChannel`s, so a target here is a
 * DESCRIPTION that {@link channelsFromTargets} turns into a channel. The config
 * a migrating app already wrote keeps working; what it drives is ours.
 */

import { ConsoleChannel } from "./channels/ConsoleChannel.js";
import { FileChannel } from "./channels/FileChannel.js";
import { SpectrumError } from "./errors.js";
import { jsonLine } from "./jsonLine.js";
import type {
	LineWritable,
	LogChannel,
	LogConfig,
	LogEntry,
	LogLevelWithSilent,
} from "./types.js";
import {
	isLogLevelWithSilent,
	LOG_LEVEL_ORDER,
	levelThreshold,
} from "./types.js";

/**
 * One transport entry (AdonisJS `TransportTargetOptions`).
 *
 * `target` names `pino-pretty` or `pino/file`, or is a {@link LogChannel}:
 * a destination spectrum has no built-in channel for is plugged in that way,
 * with the target's own level.
 */
export interface TransportTargetOptions {
	target: string | LogChannel;
	options?: Record<string, unknown>;
	level?: LogLevelWithSilent | string;
}

/** Options `targets.file()` accepts. `destination` is a path, or an fd. */
export interface FileTargetOptions {
	destination?: string | number;
	/** `false` starts the file over instead of appending. Default true. */
	append?: boolean;
	maxSizeBytes?: number;
	maxFiles?: number;
	maxBufferBytes?: number;
	[key: string]: unknown;
}

/**
 * Options `targets.pretty()` accepts. `destination` (1 or 2) sends every
 * level to that stream; pino-pretty's formatting options are not read.
 */
export interface PrettyTargetOptions {
	destination?: number;
	[key: string]: unknown;
}

/** Builds the targets array conditionally. */
export class Targets {
	readonly #targets: TransportTargetOptions[] = [];

	push(value: TransportTargetOptions): this {
		this.#targets.push(value);
		return this;
	}

	/** Add the target only when `conditional` holds. */
	pushIf(
		conditional: boolean,
		value: TransportTargetOptions | (() => TransportTargetOptions),
	): this {
		// The factory form exists so an expensive or environment-dependent target
		// is not built when it will not be used.
		if (conditional) this.push(typeof value === "function" ? value() : value);
		return this;
	}

	/** Add the target unless `conditional` holds. */
	pushUnless(
		conditional: boolean,
		value: TransportTargetOptions | (() => TransportTargetOptions),
	): this {
		return this.pushIf(!conditional, value);
	}

	toArray(): TransportTargetOptions[] {
		return [...this.#targets];
	}
}

function fileTarget(
	options: FileTargetOptions = {},
	level?: LogLevelWithSilent | string,
): TransportTargetOptions {
	return { target: "pino/file", options, ...(level ? { level } : {}) };
}

function prettyTarget(
	options: PrettyTargetOptions = {},
	level?: LogLevelWithSilent | string,
): TransportTargetOptions {
	return { target: "pino-pretty", options, ...(level ? { level } : {}) };
}

/** Start a conditional targets list; `targets.file` / `targets.pretty` build entries. */
export const targets: (() => Targets) & {
	file: typeof fileTarget;
	pretty: typeof prettyTarget;
} = Object.assign(() => new Targets(), {
	file: fileTarget,
	pretty: prettyTarget,
});

/**
 * A channel that only sees the entries its target's own level admits.
 *
 * `targets.file({ destination: 'app.log' }, 'error')` is a statement about that
 * destination, not about the logger: upstream gives every transport its own
 * level and pino filters per target. Dropping it sent every debug line — request
 * bodies, tokens, whatever the app logs while it is being debugged — into the
 * file the deployment had scoped down to errors.
 */
class LeveledChannel implements LogChannel {
	readonly name: string;
	readonly #inner: LogChannel;
	readonly #threshold: number;

	constructor(inner: LogChannel, threshold: number) {
		this.#inner = inner;
		this.#threshold = threshold;
		this.name = inner.name;
	}

	write(entry: LogEntry): void {
		if (LOG_LEVEL_ORDER[entry.level] < this.#threshold) return;
		this.#inner.write(entry);
	}

	/**
	 * Forwarded because the wrapper is now what the provider holds, and a
	 * FileChannel that is never closed keeps its file open past shutdown.
	 * The inner promise is handed back: dropping it let shutdown resolve
	 * before any line of a file target was flushed.
	 */
	close(): void | Promise<void> {
		return this.#inner.close?.();
	}
}

/** Gate a channel on a target level, when the target names one. */
function atLevel(channel: LogChannel, level: string | undefined): LogChannel {
	if (level === undefined) return channel;
	if (!isLogLevelWithSilent(level)) {
		// A level nobody can act on is a config error, and the failure mode of
		// ignoring it is the destination receiving everything.
		throw new SpectrumError(
			"E_SPECTRUM_UNKNOWN_LEVEL",
			`Unknown transport target level "${level}". Use one of: ${Object.keys(LOG_LEVEL_ORDER).join(", ")}, silent.`,
		);
	}
	const threshold = levelThreshold(level);
	// `trace` admits everything the logger already let through.
	if (threshold <= LOG_LEVEL_ORDER.trace) return channel;
	return new LeveledChannel(channel, threshold);
}

/**
 * JSON to a file descriptor, every level to that one descriptor, as pino's
 * file target writes it. Splitting by level sent a `destination: 1` app's
 * errors to stderr, where a collector reading stdout never saw them, and
 * ignored any other descriptor. No destination means 1, as upstream.
 */
function descriptorChannel(destination: unknown): LogChannel {
	if (destination === undefined || destination === 1) {
		return new ConsoleChannel("json", { stream: "stdout" });
	}
	if (destination === 2)
		return new ConsoleChannel("json", { stream: "stderr" });
	if (typeof destination === "number")
		return new FileChannel({ fd: destination });
	throw new SpectrumError(
		"E_SPECTRUM_INVALID_FILE_OPTIONS",
		`pino/file destination must be a path or a file descriptor, got ${typeof destination}`,
	);
}

/**
 * Turn transport targets into the channels spectrum actually writes through.
 *
 * `pino-pretty` is the human-readable console; `pino/file` writes JSON — to a
 * file when `destination` is a path, and to that descriptor when it is one:
 * `destination: 1` is stdout, which a containerised app ships to its log
 * collector.
 *
 * A target with no level of its own inherits `inheritedLevel`, the level of the
 * logger it belongs to — upstream's `defineConfig` fills the same gap, by
 * writing the level into the target. Passing it instead of writing it leaves
 * the caller's config object alone.
 */
export function channelsFromTargets(
	list: readonly TransportTargetOptions[],
	inheritedLevel?: LogLevelWithSilent | string,
): LogChannel[] {
	return list.map((entry) =>
		atLevel(channelForTarget(entry), entry.level ?? inheritedLevel),
	);
}

/**
 * The channel a target describes.
 *
 * Any other target name used to fall through to JSON on stdout, so a config
 * shipping logs to Loki or a socket booted fine and nothing reached the sink.
 * Upstream fails when it cannot load a target; so does this.
 */
function channelForTarget(entry: TransportTargetOptions): LogChannel {
	const { target } = entry;
	const options = entry.options ?? {};
	if (typeof target !== "string") return target;
	if (target === "pino-pretty") return prettyChannel(options.destination);
	if (target === "pino/file") {
		const destination = options.destination;
		if (typeof destination !== "string") return descriptorChannel(destination);
		return new FileChannel({
			path: destination,
			append: optionalBoolean(options, "append"),
			maxSizeBytes: optionalNumber(options, "maxSizeBytes"),
			maxFiles: optionalNumber(options, "maxFiles"),
			maxBufferBytes: optionalNumber(options, "maxBufferBytes"),
		});
	}
	throw new SpectrumError(
		"E_SPECTRUM_UNSUPPORTED_TARGET",
		`Transport target "${target}" is not supported: spectrum builds "pino-pretty" and "pino/file". Pass a LogChannel as the target to write anywhere else.`,
	);
}

function prettyChannel(destination: unknown): LogChannel {
	if (destination === undefined) return new ConsoleChannel("pretty");
	if (destination === 1)
		return new ConsoleChannel("pretty", { stream: "stdout" });
	if (destination === 2)
		return new ConsoleChannel("pretty", { stream: "stderr" });
	throw new SpectrumError(
		"E_SPECTRUM_UNSUPPORTED_TARGET",
		`pino-pretty destination ${JSON.stringify(destination)} is not supported: use 1 or 2, or a pino/file target for a file.`,
	);
}

/** A number option, or undefined when absent; any other type is a config error. */
function optionalNumber(
	options: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = options[key];
	if (value === undefined || typeof value === "number") return value;
	throw invalidOption(key, "number", value);
}

/** A boolean option, or undefined when absent; any other type is a config error. */
function optionalBoolean(
	options: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = options[key];
	if (value === undefined || typeof value === "boolean") return value;
	throw invalidOption(key, "boolean", value);
}

function invalidOption(
	key: string,
	type: string,
	value: unknown,
): SpectrumError {
	return new SpectrumError(
		"E_SPECTRUM_INVALID_FILE_OPTIONS",
		`pino/file option ${key} must be a ${type}, got ${typeof value}`,
	);
}

/** JSON lines to anything with a `write(line)` method. */
class WritableChannel implements LogChannel {
	readonly name = "destination";
	readonly #target: LineWritable;

	constructor(target: LineWritable) {
		this.#target = target;
	}

	write(entry: LogEntry): void {
		this.#target.write(`${jsonLine(entry)}\n`);
	}
}

function isLineWritable(value: unknown): value is LineWritable {
	return (
		typeof value === "object" &&
		value !== null &&
		"write" in value &&
		typeof value.write === "function"
	);
}

/** The channel a logger's `destination` option names. */
export function destinationChannel(destination: unknown): LogChannel {
	if (typeof destination === "string")
		return new FileChannel({ path: destination });
	if (typeof destination === "number") return descriptorChannel(destination);
	if (isLineWritable(destination)) return new WritableChannel(destination);
	throw new SpectrumError(
		"E_SPECTRUM_UNSUPPORTED_TARGET",
		"destination must be a path, a file descriptor or an object with a write(line) method",
	);
}

/**
 * The channels a config's `destination` or `transport` describe, or
 * `undefined` when it declares neither. `destination` wins over `transport`,
 * as upstream; a transport is either a `targets` list or one
 * `{ target, options }`.
 */
export function channelsFromConfig(
	config: Pick<LogConfig, "destination" | "transport">,
	level: LogLevelWithSilent | string | undefined,
): LogChannel[] | undefined {
	if (config.destination !== undefined) {
		return [destinationChannel(config.destination)];
	}
	const transport = config.transport;
	if (transport === undefined) return undefined;
	if ("target" in transport) return channelsFromTargets([transport], level);
	if (Reflect.get(transport, "pipeline") !== undefined) {
		throw new SpectrumError(
			"E_SPECTRUM_UNSUPPORTED_TARGET",
			"transport.pipeline is not supported: declare targets, or pass channels",
		);
	}
	if (transport.targets === undefined || transport.targets.length === 0) {
		return undefined;
	}
	return channelsFromTargets(transport.targets, level);
}
