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
import type { LogChannel, LogLevelWithSilent } from "./types.js";

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
 * Turn transport targets into the channels spectrum actually writes through.
 *
 * `pino-pretty` is the human-readable console; `pino/file` writes JSON — to a
 * file when `destination` is a path, and to the console when it is a file
 * descriptor, which is what `destination: 1` means in a containerised app that
 * ships stdout to its log collector.
 */
export function channelsFromTargets(
	list: readonly TransportTargetOptions[],
): LogChannel[] {
	const channels: LogChannel[] = [];
	for (const entry of list) {
		if (entry.target === "pino-pretty") {
			channels.push(new ConsoleChannel("pretty"));
			continue;
		}
		const destination = entry.options?.destination;
		if (typeof destination === "string") {
			channels.push(
				new FileChannel({
					path: destination,
					...(typeof entry.options?.maxSizeBytes === "number"
						? { maxSizeBytes: entry.options.maxSizeBytes }
						: {}),
					...(typeof entry.options?.maxFiles === "number"
						? { maxFiles: entry.options.maxFiles }
						: {}),
				}),
			);
			continue;
		}
		// A descriptor (or nothing) means the process's own output, as JSON —
		// the shape a log collector parses.
		channels.push(new ConsoleChannel("json"));
	}
	return channels;
}
