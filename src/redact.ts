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

/**
 * fast-redact's own tokenizer: a run of characters that is not `.`, `[` or
 * `]`, or anything between a pair of brackets.
 */
const PATH_TOKEN = /[^.[\]]+|\[(?:.)*?\]/g;

/**
 * Split a redaction path into the keys it names.
 *
 * `a["b-c"]` and `a.b-c` name the same key: the brackets and the quotes are
 * notation, not part of the name.
 */
export function parseRedactPath(path: string): string[] {
	const tokens = path.match(PATH_TOKEN);
	if (!tokens) return [];
	return tokens.map((token) => {
		const inner = token.startsWith("[") ? token.slice(1, -1) : token;
		return inner.replace(/['"`]/g, "");
	});
}

/**
 * Replace everything `tokens` selects with `censor`, without touching the
 * input.
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
	censor: string,
	depth = 0,
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
		const next = isLast
			? censor
			: redactPath(current, tokens, censor, depth + 1);
		if (next === current) continue;
		if (!copy) copy = Array.isArray(node) ? [...node] : { ...node };
		writeKey(copy, key, next);
	}
	return copy ?? node;
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

function readKey(node: object, key: string): unknown {
	const own = Object.getOwnPropertyDescriptor(node, key);
	return own === undefined ? undefined : own.value;
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
	node[key] = value;
}
