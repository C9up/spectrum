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
import type { LogChannel, LogEntry, LogLevelWithSilent } from "./types.js";
import {
	isLogLevelWithSilent,
	LOG_LEVEL_ORDER,
	levelThreshold,
} from "./types.js";

/** One transport entry (AdonisJS `TransportTargetOptions`). */
export interface TransportTargetOptions {
	target: string;
	options?: Record<string, unknown>;
	level?: LogLevelWithSilent | string;
}

/** Options `targets.file()` accepts. `destination` is a path, or an fd. */
export interface FileTargetOptions {
	destination?: string | number;
	maxSizeBytes?: number;
	maxFiles?: number;
	[key: string]: unknown;
}

/** Options `targets.pretty()` accepts (pino-pretty's, which we ignore). */
export interface PrettyTargetOptions {
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
	 * FileChannel that is never closed keeps its stream open past shutdown.
	 */
	close(): void {
		const inner: LogChannel & { close?: () => void } = this.#inner;
		inner.close?.();
	}
}

/** Gate a channel on a target level, when the target names one. */
function atLevel(channel: LogChannel, level: string | undefined): LogChannel {
	if (level === undefined) return channel;
	if (!isLogLevelWithSilent(level)) {
		// A level nobody can act on is a config error, and the failure mode of
		// ignoring it is the destination receiving everything.
		throw new Error(
			`[spectrum] Unknown transport target level "${level}". Use one of: ${Object.keys(LOG_LEVEL_ORDER).join(", ")}, silent.`,
		);
	}
	const threshold = levelThreshold(level);
	// `trace` admits everything the logger already let through.
	if (threshold <= LOG_LEVEL_ORDER.trace) return channel;
	return new LeveledChannel(channel, threshold);
}

/**
 * Turn transport targets into the channels spectrum actually writes through.
 *
 * `pino-pretty` is the human-readable console; `pino/file` writes JSON — to a
 * file when `destination` is a path, and to the console when it is a file
 * descriptor, which is what `destination: 1` means in a containerised app that
 * ships stdout to its log collector.
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
	const channels: LogChannel[] = [];
	for (const entry of list) {
		const level = entry.level ?? inheritedLevel;
		if (entry.target === "pino-pretty") {
			channels.push(atLevel(new ConsoleChannel("pretty"), level));
			continue;
		}
		const destination = entry.options?.destination;
		if (typeof destination === "string") {
			channels.push(
				atLevel(
					new FileChannel({
						path: destination,
						...(typeof entry.options?.maxSizeBytes === "number"
							? { maxSizeBytes: entry.options.maxSizeBytes }
							: {}),
						...(typeof entry.options?.maxFiles === "number"
							? { maxFiles: entry.options.maxFiles }
							: {}),
					}),
					level,
				),
			);
			continue;
		}
		// A descriptor (or nothing) means the process's own output, as JSON —
		// the shape a log collector parses.
		channels.push(atLevel(new ConsoleChannel("json"), level));
	}
	return channels;
}
