/**
 * How a log line is turned into JSON without ever losing it.
 *
 * A bare `JSON.stringify(entry)` throws on a circular reference or a BigInt,
 * and a throw there costs the whole line — every field of it, on every
 * channel. Circular payloads are ordinary (an ORM model with a back-reference,
 * an HTTP client error carrying its request), so the line that explains a
 * failure is the one most likely to vanish.
 *
 * pino's answer, mirrored: `JSON.stringify` first, because it is fast and
 * exact; when it throws, the field is written again by a bounded walker that
 * prints a cycle as `"[Circular]"`, a BigInt as a number, anything deeper than
 * `depthLimit` as `"[Object]"` / `"[Array]"`, and stops after `edgeLimit`
 * entries. Each top-level field falls back on its own, so one bad field does
 * not degrade the others.
 */

export interface StringifyLimits {
	/** How deep the fallback walks before writing `"[Object]"`. Default 5. */
	depthLimit: number;
	/** How many entries of one object or array the fallback writes. Default 100. */
	edgeLimit: number;
}

export const DEFAULT_STRINGIFY_LIMITS: StringifyLimits = {
	depthLimit: 5,
	edgeLimit: 100,
};

const UNSERIALIZABLE =
	'"[unable to serialize, circular reference is too complex to analyze]"';

/**
 * Limits a logger configured for its own entries.
 *
 * Channels are built independently of the logger that writes to them, so the
 * limits travel with the entry instead of through every channel constructor.
 * Weak, so an entry that has been written leaves nothing behind.
 */
const entryLimits = new WeakMap<object, StringifyLimits>();

/** @internal Attach a logger's limits to an entry it is about to write. */
export function attachStringifyLimits(
	entry: object,
	limits: StringifyLimits,
): void {
	entryLimits.set(entry, limits);
}

/** The limits a channel should use for this entry. */
export function stringifyLimitsFor(entry: object): StringifyLimits {
	return entryLimits.get(entry) ?? DEFAULT_STRINGIFY_LIMITS;
}

/** Whether a configured limit is one the walker can honour. */
export function isStringifyLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * One JSON object, never throwing. Keys whose value is `undefined` or a
 * function are left out, as `JSON.stringify` leaves them out.
 */
export function stringifyRecord(
	record: Record<string, unknown>,
	limits: StringifyLimits = DEFAULT_STRINGIFY_LIMITS,
): string {
	try {
		return JSON.stringify(record);
	} catch {
		// Field by field, so the fallback's limits count from each field and a
		// field that cannot be written at all is the only one that says so.
		let out = "";
		for (const key of Object.keys(record)) {
			const value = stringifyValue(readField(record, key), limits);
			if (value === undefined) continue;
			out += `${out === "" ? "" : ","}${JSON.stringify(key)}:${value}`;
		}
		return `{${out}}`;
	}
}

/** One value, never throwing; `undefined` when JSON would omit it. */
export function stringifyValue(
	value: unknown,
	limits: StringifyLimits = DEFAULT_STRINGIFY_LIMITS,
): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		try {
			return walk("", value, [], limits);
		} catch {
			return UNSERIALIZABLE;
		}
	}
}

/** A getter that throws is a value that cannot be written, not a lost line. */
function readField(record: object, key: string): unknown {
	try {
		return Reflect.get(record, key);
	} catch {
		return "[unreadable]";
	}
}

function hasToJSON(value: object): value is { toJSON(key: string): unknown } {
	return "toJSON" in value && typeof value.toJSON === "function";
}

function itemCount(count: number): string {
	return count === 1 ? "1 item" : `${count} items`;
}

/**
 * The bounded fallback. `stack` holds the objects on the current path, so a
 * value shared by two branches is written twice and only a real cycle is cut.
 */
function walk(
	key: string,
	input: unknown,
	stack: object[],
	limits: StringifyLimits,
): string | undefined {
	let value = input;
	if (typeof value === "object" && value !== null && hasToJSON(value)) {
		value = value.toJSON(key);
	}
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "number":
			return Number.isFinite(value) ? String(value) : "null";
		case "boolean":
			return value ? "true" : "false";
		case "bigint":
			return String(value);
		case "object": {
			if (value === null) return "null";
			if (stack.includes(value)) return '"[Circular]"';
			if (Array.isArray(value)) return walkArray(value, stack, limits);
			return walkObject(value, stack, limits);
		}
		default:
			// undefined, function, symbol: omitted, as JSON omits them.
			return undefined;
	}
}

function walkArray(
	value: unknown[],
	stack: object[],
	limits: StringifyLimits,
): string {
	if (value.length === 0) return "[]";
	if (stack.length + 1 > limits.depthLimit) return '"[Array]"';
	stack.push(value);
	const shown = Math.min(value.length, limits.edgeLimit);
	const parts: string[] = [];
	for (let i = 0; i < shown; i++) {
		parts.push(walk(String(i), value[i], stack, limits) ?? "null");
	}
	if (value.length > shown) {
		parts.push(
			JSON.stringify(`... ${itemCount(value.length - shown)} not stringified`),
		);
	}
	stack.pop();
	return `[${parts.join(",")}]`;
}

function walkObject(
	value: object,
	stack: object[],
	limits: StringifyLimits,
): string {
	const keys = Object.keys(value);
	if (keys.length === 0) return "{}";
	if (stack.length + 1 > limits.depthLimit) return '"[Object]"';
	stack.push(value);
	const shown = Math.min(keys.length, limits.edgeLimit);
	const parts: string[] = [];
	for (let i = 0; i < shown; i++) {
		const key = keys[i];
		if (key === undefined) continue;
		const written = walk(key, readField(value, key), stack, limits);
		if (written !== undefined) parts.push(`${JSON.stringify(key)}:${written}`);
	}
	if (keys.length > shown) {
		parts.push(
			`"...":${JSON.stringify(`${itemCount(keys.length - shown)} not stringified`)}`,
		);
	}
	stack.pop();
	return `{${parts.join(",")}}`;
}
