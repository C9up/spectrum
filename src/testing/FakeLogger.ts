/**
 * In-memory `LogChannel` for tests — captures every `write(entry)`
 * and exposes Adonis/Laravel-style `assertLogged` /
 * `assertNotLogged` helpers in the same shape as Rover's
 * `FakeMail` and Bay's `FakeQueue`.
 *
 * Not re-exported from the main barrel; reach via
 * `@c9up/spectrum/testing`.
 */

import {
	E_SPECTRUM_ASSERTION_FAILED,
	E_SPECTRUM_INVALID_PREDICATE,
} from "../errors.js";
import type { LogChannel, LogEntry, LogLevel } from "../types.js";
import { LOG_LEVEL_ORDER, logEntryExtras } from "../types.js";

export interface FakeLoggerPredicate {
	/** Substring match against `entry.message`. */
	containing?: string;
	/** Custom predicate against `entry.data`. */
	dataMatches?: (data: Record<string, unknown> | undefined) => boolean;
}

export type FakeLoggerPredicateArg =
	| FakeLoggerPredicate
	| ((entry: LogEntry) => boolean);

export class FakeLogger implements LogChannel {
	readonly name = "fake";
	#captured: LogEntry[] = [];

	write(entry: LogEntry): void {
		// Deep-clone the whole entry so nested objects in `data` OR in the
		// merged root fields are isolated — a shallow copy would leak mutations
		// of nested fields back into the captured entry.
		this.#captured.push(deepClone(entry));
	}

	/** Defensive snapshot of every captured entry. */
	getLogged(): LogEntry[] {
		return this.#captured.map((e) => deepClone(e));
	}

	reset(): void {
		this.#captured = [];
	}

	assertLogged(level: LogLevel, predicate?: FakeLoggerPredicateArg): void {
		const match = makeMatcher(level, predicate);
		if (this.#captured.some(match)) return;
		throw new E_SPECTRUM_ASSERTION_FAILED([
			`logger.assertLogged('${level}'${describePredicate(predicate)}) failed — no captured entry matches.\n${describeCaptured(this.#captured)}`,
		]);
	}

	assertNotLogged(level: LogLevel, predicate?: FakeLoggerPredicateArg): void {
		const match = makeMatcher(level, predicate);
		if (!this.#captured.some(match)) return;
		throw new E_SPECTRUM_ASSERTION_FAILED([
			`logger.assertNotLogged('${level}'${describePredicate(predicate)}) failed — at least one captured entry matches.\n${describeCaptured(this.#captured)}`,
		]);
	}
}

function makeMatcher(
	level: LogLevel,
	predicate: FakeLoggerPredicateArg | undefined,
): (e: LogEntry) => boolean {
	if (typeof predicate === "function") {
		return (e) => e.level === level && predicate(e);
	}
	if (predicate === undefined) {
		return (e) => e.level === level;
	}
	// Validate the predicate AT CONSTRUCTION, not inside the closure —
	// Array.some short-circuits on an empty array, so a check inside
	// the matcher would silently pass when nothing was captured.
	if (predicate.containing === "") {
		throw new E_SPECTRUM_INVALID_PREDICATE();
	}
	return (e) => {
		if (e.level !== level) return false;
		if (
			predicate.containing !== undefined &&
			!e.message.includes(predicate.containing)
		) {
			return false;
		}
		// New-style logs merge structured fields at the entry root; fall back to
		// those when the legacy `data` bag is absent so `dataMatches` still works.
		const bag = e.data ?? logEntryExtras(e);
		if (predicate.dataMatches && !predicate.dataMatches(bag)) {
			return false;
		}
		return true;
	};
}

function describePredicate(
	predicate: FakeLoggerPredicateArg | undefined,
): string {
	if (predicate === undefined) return "";
	if (typeof predicate === "function") return ", <function predicate>";
	if (Object.keys(predicate).length === 0)
		return ", <empty predicate (level-only)>";
	return `, ${safeStringify(predicate)}`;
}

function describeCaptured(captured: LogEntry[]): string {
	if (captured.length === 0) return "Captured: (none)";
	const lines = captured.map(
		(e, i) => `  [${i}] ${e.level} module="${e.module}" message="${e.message}"`,
	);
	return `Captured (${captured.length}):\n${lines.join("\n")}`;
}

/**
 * `JSON.stringify` for an assertion message: a function renders as
 * `<function>`, a BigInt as `<digits>n`, a cycle as `<circular>`, and a value
 * that still cannot be written as `<unstringifiable>` — so a failure message
 * is never eaten by a JSON throw.
 *
 * Only a cycle is cut. `path` holds the objects from the root to the value
 * being written, so a value reached through two keys is written under both, as
 * `JSON.stringify` writes it; remembering every object seen dropped the second
 * one. The same rule as `@c9up/ream`'s `src/utils/safeStringify.ts`, kept as a
 * local copy because this message format differs from a response body's.
 */
function safeStringify(value: unknown): string {
	const path: object[] = [];
	try {
		const out: string | undefined = JSON.stringify(
			value,
			function replace(this: unknown, _key: string, v: unknown) {
				if (typeof v === "function") return "<function>";
				if (typeof v === "bigint") return `${v}n`;
				if (typeof v !== "object" || v === null) return v;
				while (path.length > 0 && path[path.length - 1] !== this) path.pop();
				if (path.includes(v)) return "<circular>";
				path.push(v);
				return v;
			},
		);
		return out ?? "undefined";
	} catch {
		return "<unstringifiable>";
	}
}

function deepClone(entry: LogEntry): LogEntry {
	try {
		return structuredClone(entry);
	} catch {
		// `data` can carry a function, which structuredClone rejects
		// (DataCloneError). The entry must still be CAPTURED and assertable —
		// the throw used to propagate into Logger.log's swallow, dropping the
		// entry and making assertLogged fail with "no entry". So it is copied
		// by hand: plain objects and arrays anew, a value reached twice copied
		// once and shared again, a cycle kept a cycle, a function kept as it is.
		// The JSON round-trip this replaces turned functions into strings and
		// dropped a value's second reference.
		const copy = copyValue(entry, new Map());
		return isLogEntry(copy) ? copy : entry;
	}
}

/**
 * A copy of `value` for a test capture. `copies` maps every object already
 * copied to its copy, so sharing and cycles come out as they went in.
 */
function copyValue(value: unknown, copies: Map<object, unknown>): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (copies.has(value)) return copies.get(value);
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		copies.set(value, out);
		for (const item of value) out.push(copyValue(item, copies));
		return out;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	if (proto === Object.prototype || proto === null) {
		const out: Record<string, unknown> =
			proto === null ? Object.create(null) : {};
		copies.set(value, out);
		for (const [key, item] of Object.entries(value)) {
			// defineProperty, not assignment: an own `__proto__` key stays a key.
			Object.defineProperty(out, key, {
				value: copyValue(item, copies),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return out;
	}
	// Anything else (a Date, a Map, a class instance) is cloned whole when
	// structuredClone can, and kept as it is when it cannot.
	try {
		const out: unknown = structuredClone(value);
		copies.set(value, out);
		return out;
	} catch {
		copies.set(value, value);
		return value;
	}
}

/** What came back from the JSON round-trip still has the shape of an entry. */
function isLogEntry(value: unknown): value is LogEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		"level" in value &&
		typeof value.level === "string" &&
		value.level in LOG_LEVEL_ORDER &&
		"message" in value &&
		typeof value.message === "string" &&
		"module" in value &&
		typeof value.module === "string" &&
		"timestamp" in value &&
		typeof value.timestamp === "string"
	);
}
