/**
 * In-memory `LogChannel` for tests — captures every `write(entry)`
 * and exposes Adonis/Laravel-style `assertLogged` /
 * `assertNotLogged` helpers in the same shape as Rover's
 * `FakeMail` and Bay's `FakeQueue`.
 *
 * Not re-exported from the main barrel; reach via
 * `@c9up/spectrum/testing`.
 */

import type { LogChannel, LogEntry, LogLevel } from "../types.js";

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
		// Deep-clone via `structuredClone` so nested objects in `data`
		// are isolated — a shallow `{ ...entry.data }` would leak
		// mutations of nested fields back into the captured entry.
		this.#captured.push({
			...entry,
			data: entry.data ? deepClone(entry.data) : undefined,
		});
	}

	/** Defensive snapshot of every captured entry. */
	getLogged(): LogEntry[] {
		return this.#captured.map((e) => ({
			...e,
			data: e.data ? deepClone(e.data) : undefined,
		}));
	}

	reset(): void {
		this.#captured = [];
	}

	assertLogged(level: LogLevel, predicate?: FakeLoggerPredicateArg): void {
		const match = makeMatcher(level, predicate);
		if (this.#captured.some(match)) return;
		throw new Error(
			`logger.assertLogged('${level}'${describePredicate(predicate)}) failed — no captured entry matches.\n${describeCaptured(this.#captured)}`,
		);
	}

	assertNotLogged(level: LogLevel, predicate?: FakeLoggerPredicateArg): void {
		const match = makeMatcher(level, predicate);
		if (!this.#captured.some(match)) return;
		throw new Error(
			`logger.assertNotLogged('${level}'${describePredicate(predicate)}) failed — at least one captured entry matches.\n${describeCaptured(this.#captured)}`,
		);
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
		throw new Error(
			"FakeLogger: `containing` predicate cannot be an empty string — it would match every captured message.",
		);
	}
	return (e) => {
		if (e.level !== level) return false;
		if (
			predicate.containing !== undefined &&
			!e.message.includes(predicate.containing)
		) {
			return false;
		}
		if (predicate.dataMatches && !predicate.dataMatches(e.data)) {
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

/** `JSON.stringify` with circular-ref + function-field handling.
 *  Functions render as `<function>`, circular refs as `<circular>`,
 *  unstringifiable values as `<unstringifiable>` — so an assertion
 *  failure message never gets eaten by a JSON throw. */
function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return JSON.stringify(value, (_key, v: unknown) => {
			if (typeof v === "function") return "<function>";
			if (typeof v === "object" && v !== null) {
				if (seen.has(v)) return "<circular>";
				seen.add(v);
			}
			return v;
		});
	} catch {
		return "<unstringifiable>";
	}
}

function deepClone<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		// `data` can carry functions / class instances that structuredClone
		// rejects (DataCloneError). For a test capture a perfect clone isn't
		// needed — round-trip through safeStringify (functions → "<function>",
		// circular → "<circular>") so the entry is still CAPTURED and assertable
		// instead of thrown away (the throw propagated into Logger.log's swallow,
		// dropping the entry and making assertLogged fail with "no entry").
		try {
			return JSON.parse(safeStringify(value));
		} catch {
			return value;
		}
	}
}
