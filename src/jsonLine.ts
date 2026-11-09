/**
 * The JSON line a structured channel writes: pino's shape.
 *
 *   {"level":30,"time":1731000000000,"pid":4242,"hostname":"web-1","module":"app","userId":7,"msg":"signed in"}
 *
 * Numeric `level`, epoch-millisecond `time`, `pid` and `hostname` from `base`,
 * bindings and merged fields at the root, the message under `msg` — what a
 * dashboard, an alert rule or `pino-pretty` reads from a pino line. The keys
 * and the time format follow the logger's `messageKey`, `timestamp`, `base`
 * and `formatters` options, as they do upstream.
 */

import { hostname } from "node:os";
import { SpectrumError } from "./errors.js";
import {
	DEFAULT_STRINGIFY_LIMITS,
	type StringifyLimits,
	stringifyRecord,
} from "./stringify.js";
import type { LogEntry, LogLevel } from "./types.js";
import { LOG_LEVEL_ORDER, logEntryExtras } from "./types.js";

/**
 * How `time` is written: `'epoch'` (ms, the default), `'iso'`, `'unix'`
 * (seconds), `false` to leave it out, or a function returning the raw
 * fragment to append (`,"time":…`), as upstream's time functions do.
 */
export type TimestampOption =
	| "epoch"
	| "iso"
	| "unix"
	| boolean
	| (() => string);

export interface LineFormatters {
	/** The level's part of the line. Default `{ level: <number> }`. */
	level?: (label: LogLevel, number: number) => Record<string, unknown>;
	/** Reshape the merged fields (bindings and merging object) before writing. */
	log?: (object: Record<string, unknown>) => Record<string, unknown>;
}

export interface JsonLineOptions {
	messageKey: string;
	timestamp: TimestampOption;
	/** Fields written on every line; `null` for none. */
	base: Record<string, unknown> | null;
	formatters: LineFormatters;
	limits: StringifyLimits;
}

const DEFAULT_BASE: Record<string, unknown> = {
	pid: process.pid,
	hostname: hostname(),
};

export const DEFAULT_LINE_OPTIONS: JsonLineOptions = {
	messageKey: "msg",
	timestamp: "epoch",
	base: DEFAULT_BASE,
	formatters: {},
	limits: DEFAULT_STRINGIFY_LIMITS,
};

/**
 * The options a logger configured for its entries. Channels are built
 * independently of the logger writing to them, so the options travel with the
 * entry; weak, so a written entry leaves nothing behind.
 */
const entryOptions = new WeakMap<object, JsonLineOptions>();

/** @internal Attach a logger's line options to an entry it is about to write. */
export function attachLineOptions(
	entry: object,
	options: JsonLineOptions,
): void {
	entryOptions.set(entry, options);
}

/** The line options for this entry: its logger's, else the defaults. */
export function lineOptionsFor(entry: object): JsonLineOptions {
	return entryOptions.get(entry) ?? DEFAULT_LINE_OPTIONS;
}

function invalid(detail: string): SpectrumError {
	return new SpectrumError("E_SPECTRUM_INVALID_LINE_OPTIONS", detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check the line options a config declares, filling in the defaults. */
export function resolveLineOptions(config: {
	messageKey?: string;
	timestamp?: TimestampOption;
	base?: Record<string, unknown> | null;
	formatters?: LineFormatters;
	limits: StringifyLimits;
}): JsonLineOptions {
	const { messageKey, timestamp, base, formatters } = config;
	if (
		messageKey !== undefined &&
		(typeof messageKey !== "string" || messageKey === "")
	) {
		throw invalid("messageKey must be a non-empty string");
	}
	if (
		timestamp !== undefined &&
		typeof timestamp !== "boolean" &&
		typeof timestamp !== "function" &&
		timestamp !== "epoch" &&
		timestamp !== "iso" &&
		timestamp !== "unix"
	) {
		throw invalid(
			`timestamp must be 'epoch', 'iso', 'unix', a boolean or a function, got ${String(timestamp)}`,
		);
	}
	if (base !== undefined && base !== null && !isRecord(base)) {
		throw invalid("base must be an object or null");
	}
	// Checked at run time too: a JavaScript config is not held to the types.
	if (formatters !== undefined && !isRecord(formatters)) {
		throw invalid("formatters must be an object");
	}
	const level: unknown = formatters?.level;
	const log: unknown = formatters?.log;
	if (level !== undefined && typeof level !== "function") {
		throw invalid("formatters.level must be a function");
	}
	if (log !== undefined && typeof log !== "function") {
		throw invalid("formatters.log must be a function");
	}
	return {
		messageKey: messageKey ?? DEFAULT_LINE_OPTIONS.messageKey,
		timestamp: timestamp ?? DEFAULT_LINE_OPTIONS.timestamp,
		base: base === undefined ? DEFAULT_BASE : base,
		formatters: guardFormatters(formatters ?? {}),
		limits: config.limits,
	};
}

/**
 * Formatters whose output is checked: one returning something other than an
 * object would otherwise break the line it formats.
 */
function guardFormatters(formatters: LineFormatters): LineFormatters {
	const { level, log } = formatters;
	return {
		...(level !== undefined
			? {
					level: (label: LogLevel, number: number) => {
						const out: unknown = level(label, number);
						return isRecord(out) ? out : { level: number };
					},
				}
			: {}),
		...(log !== undefined
			? {
					log: (object: Record<string, unknown>) => {
						const out: unknown = log(object);
						return isRecord(out) ? out : object;
					},
				}
			: {}),
	};
}

/** The `,"time":…` fragment, or "" when time is not written. */
function timeFragment(option: TimestampOption, iso: string): string {
	if (option === false) return "";
	if (typeof option === "function") return String(option());
	const ms = Date.parse(iso);
	// A hand-built entry may carry a timestamp that is no date: written as
	// given rather than as `NaN`, which is not JSON and would break the line.
	if (option === "iso" || !Number.isFinite(ms)) {
		return `,"time":${JSON.stringify(iso)}`;
	}
	if (option === "unix") return `,"time":${Math.round(ms / 1000)}`;
	return `,"time":${ms}`;
}

/** `{…}` → `…`, so parts can be joined into one object. */
function inner(json: string): string {
	return json.slice(1, -1);
}

/** One JSON line (no trailing newline) for an entry. */
export function jsonLine(entry: LogEntry): string {
	const options = lineOptionsFor(entry);
	const number = LOG_LEVEL_ORDER[entry.level];
	const levelPart = options.formatters.level
		? options.formatters.level(entry.level, number)
		: { level: number };

	let fields: Record<string, unknown> = {
		...(options.base ?? {}),
		module: entry.module,
		correlationId: entry.correlationId,
		data: entry.data,
		...logEntryExtras(entry),
	};
	if (options.formatters.log) fields = options.formatters.log(fields);
	// A merged field named like the level, the time or the message would be
	// read as the line's own (JSON.parse keeps the last duplicate), so a
	// merging object could forge them. They are written once, by the logger.
	const levelKeys = new Set(Object.keys(levelPart));
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (levelKeys.has(key) || key === "time" || key === options.messageKey)
			continue;
		rest[key] = value;
	}
	rest[options.messageKey] = entry.message;

	const parts = [
		inner(stringifyRecord(levelPart, options.limits)),
		timeFragment(options.timestamp, entry.timestamp).replace(/^,/, ""),
		inner(stringifyRecord(rest, options.limits)),
	].filter((part) => part !== "");
	return `{${parts.join(",")}}`;
}
