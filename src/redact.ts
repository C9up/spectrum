/**
 * Redaction paths, in the syntax pino's `redact` option is written in.
 *
 * Upstream hands those paths to `fast-redact`, so a migrated `config/logger.ts`
 * legitimately contains `req.headers.authorization`, `*.password`,
 * `users[*].token` and `headers["set-cookie"]`. Understanding only the first of
 * those — a literal dot-path — is not a smaller feature: it is a redaction that
 * silently does nothing. The config says the password is censored, and the
 * password is written out in full.
 */

import { SpectrumError } from "./errors.js";

/**
 * fast-redact's own tokenizer: a run of characters that is not `.`, `[` or
 * `]`, or anything between a pair of brackets.
 */
const PATH_TOKEN = /[^.[\]]+|\[(?:.)*?\]/g;

function invalidPath(detail: string): SpectrumError {
	return new SpectrumError("E_SPECTRUM_INVALID_REDACT_PATH", detail);
}

/**
 * Refuse a path the tokenizer would read as something else.
 *
 * `password,token` used to parse as one key with a comma in it, match nothing,
 * and write both fields in clear under a config that reads as censoring them.
 * These are upstream's rules (empty, `..`, `,`, unbalanced brackets), checked
 * when the logger is built so a typo fails at boot instead of in production.
 */
function validateRedactPath(path: string): void {
	if (path === "" || path.includes("..") || path.includes(",")) {
		throw invalidPath(`Invalid redaction path (${path})`);
	}
	let depth = 0;
	let quote = "";
	for (const char of path) {
		if ((char === '"' || char === "'") && depth > 0) {
			if (quote === "") quote = char;
			else if (char === quote) quote = "";
		} else if (char === "[" && quote === "") {
			depth += 1;
		} else if (char === "]" && quote === "") {
			depth -= 1;
			if (depth < 0) throw invalidPath(`Invalid redaction path (${path})`);
		}
	}
	if (depth !== 0) throw invalidPath(`Invalid redaction path (${path})`);
}

/**
 * The paths of a `redact` option, checked: an array of strings, or an object
 * whose `paths` is one.
 */
export function redactPathsOf(redact: unknown): string[][] {
	if (redact === undefined) return [];
	const paths =
		typeof redact === "object" && redact !== null && "paths" in redact
			? redact.paths
			: redact;
	if (!Array.isArray(paths)) {
		throw invalidPath("redact must contain an array of strings");
	}
	return paths.map((path: unknown) => {
		if (typeof path !== "string") {
			throw invalidPath("Redaction paths must be (non-empty) strings");
		}
		return parseRedactPath(path);
	});
}

/**
 * Split a redaction path into the keys it names.
 *
 * `a["b-c"]` and `a.b-c` name the same key: the brackets and the quotes are
 * notation, not part of the name.
 */
export function parseRedactPath(path: string): string[] {
	validateRedactPath(path);
	const tokens = path.match(PATH_TOKEN);
	if (!tokens) return [];
	return tokens.map((token) => {
		const inner = token.startsWith("[") ? token.slice(1, -1) : token;
		return inner.replace(/['"`]/g, "");
	});
}

/**
 * What a matched value becomes: the censor's answer for the value and the
 * concrete path it was found at (wildcards resolved), as upstream calls a
 * censor function — or nothing at all, with `remove`.
 */
export interface RedactAction {
	censor: (value: unknown, path: string[]) => unknown;
	remove: boolean;
}

/**
 * Replace everything `tokens` selects, without touching the input.
 *
 * Copy-on-write, and the copy is only made once something actually matched —
 * so an entry with no redacted field is passed through by reference, which is
 * the common case on the hot path. The same rule is what keeps the walk
 * honest: a path that names nothing leaves the object exactly as it was
 * instead of inventing the key it was looking for.
 */
export function redactPath(
	node: unknown,
	tokens: readonly string[],
	action: RedactAction,
	depth = 0,
	trail: readonly string[] = [],
): unknown {
	const segment = tokens[depth];
	if (segment === undefined || node === null || typeof node !== "object") {
		return node;
	}

	const keys = selectKeys(node, segment);
	if (keys.length === 0) return node;

	const isLast = depth === tokens.length - 1;
	let copy: Record<string, unknown> | unknown[] | null = null;
	for (const key of keys) {
		const current = readKey(node, key);
		const path = [...trail, key];
		if (isLast && action.remove) {
			copy ??= Array.isArray(node) ? [...node] : copyObject(node);
			removeKey(copy, key);
			continue;
		}
		const next = isLast
			? action.censor(current, path)
			: redactPath(current, tokens, action, depth + 1, path);
		if (next === current) continue;
		copy ??= Array.isArray(node) ? [...node] : copyObject(node);
		writeKey(copy, key, next);
	}
	return copy ?? node;
}

function removeKey(
	node: Record<string, unknown> | unknown[],
	key: string,
): void {
	if (Array.isArray(node)) {
		const index = Number(key);
		if (Number.isInteger(index)) node[index] = undefined;
		return;
	}
	Reflect.deleteProperty(node, key);
}

/**
 * The own keys a path segment selects.
 *
 * `*` takes every one of them — on an array too, whose own keys are its
 * indices, which is what makes `users[*].token` reach into a list. Anything
 * else takes that single key, and only if the object really has it: `in` would
 * answer for `toString` and turn a redaction into an invented field.
 */
function selectKeys(node: object, segment: string): string[] {
	if (segment === "*") return Object.keys(node);
	return Object.hasOwn(node, segment) ? [segment] : [];
}

/**
 * A shallow copy that is still what the original was.
 *
 * A spread made a plain object: the class prototype went, and its `toJSON`
 * with it, so a model whose serialization hides its password hash wrote every
 * field the moment a redaction path matched inside it. Keeping the prototype
 * is what upstream's redactor does. Values are defined, not assigned, so a
 * setter on the prototype is not run against the copy.
 */
function copyObject(node: object): Record<string, unknown> {
	const copy: Record<string, unknown> = {};
	Reflect.setPrototypeOf(copy, Reflect.getPrototypeOf(node));
	for (const key of Object.keys(node)) {
		Object.defineProperty(copy, key, {
			value: readKey(node, key),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return copy;
}

/**
 * An own key's value, getter included.
 *
 * Reading the descriptor's `value` answered `undefined` for an accessor, so
 * the walk stopped there while the line, written later, ran the getter and
 * printed the secret behind it in clear. Upstream reads `source[key]`; so does
 * this. A getter that throws cannot be written either, and is not allowed to
 * take the line down with it.
 */
function readKey(node: object, key: string): unknown {
	try {
		return Reflect.get(node, key);
	} catch {
		return "[unreadable]";
	}
}

function writeKey(
	node: Record<string, unknown> | unknown[],
	key: string,
	value: unknown,
): void {
	if (Array.isArray(node)) {
		const index = Number(key);
		if (Number.isInteger(index)) node[index] = value;
		return;
	}
	Object.defineProperty(node, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}
