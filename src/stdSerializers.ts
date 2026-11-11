/**
 * The standard serializers, in the shapes upstream's `stdSerializers` write:
 * `err` for errors, `req` and `res` for Node's HTTP request and response.
 *
 *   new Logger({ serializers: { req: stdSerializers.req, res: stdSerializers.res } })
 */

/** How far down a chain of nested errors to follow. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Serialize an Error the way pino's `err` serializer does. Non-Error values
 * pass through untouched.
 *
 * `{ name, message, stack }` threw away everything the error was carrying.
 * `err.code` is usually the one field a log search is keyed on, and the `cause`
 * of a wrapped error is the half that says what actually failed — both were
 * dropped, silently, by a serializer whose job is to keep them.
 *
 * `path` holds the errors being serialized above this one. An error met again
 * on its own path is a cycle and is written as `"[Circular]"`, as upstream
 * skips an error it has already tagged; without it `err.self = err` was copied
 * down to the depth limit, and an error with k such references cost k^8 copies
 * on the logging call. An error shared by two branches is not a cycle and is
 * written in both.
 */
export function serializeError(
	value: unknown,
	path: readonly Error[] = [],
): unknown {
	if (!(value instanceof Error)) return value;
	if (path.includes(value)) return "[Circular]";
	if (path.length > MAX_CAUSE_DEPTH) return "[cause chain too deep]";
	const below = [...path, value];

	// Own ENUMERABLE properties only, which on an Error means the ones it was
	// given: `message`, `stack` and `name` are not among them.
	const out: Record<string, unknown> = { ...value };
	for (const [key, nested] of Object.entries(out)) {
		if (nested instanceof Error) out[key] = serializeError(nested, below);
	}

	// Upstream reads the constructor rather than `name`, so a subclass that
	// never assigns `this.name` is still reported as itself, and it names the
	// field `type` — which is what an Adonis log pipeline reads.
	out.type =
		typeof value.constructor === "function"
			? value.constructor.name
			: value.name;
	out.message = value.message;
	out.stack = value.stack;
	if (value instanceof AggregateError && Array.isArray(value.errors)) {
		out.aggregateErrors = value.errors.map((each: unknown) =>
			serializeError(each, below),
		);
	}
	if (value.cause !== undefined) {
		out.cause = serializeError(value.cause, below);
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * An HTTP request as upstream's `req` serializer writes it: id, method, url,
 * query, params, headers and the remote address. Every header is written as
 * it is, `cookie` and `authorization` included — censoring them is what
 * `redact` is for, and the generated config lists them.
 */
export function serializeRequest(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const info = Reflect.get(value, "info");
	const connection = isRecord(info) ? info : Reflect.get(value, "socket");
	const id = Reflect.get(value, "id");
	const originalUrl = Reflect.get(value, "originalUrl");
	const pathValue = Reflect.get(value, "path");
	const url = Reflect.get(value, "url");
	const query = Reflect.get(value, "query");
	const params = Reflect.get(value, "params");
	return {
		id:
			typeof id === "function"
				? Reflect.apply(id, value, [])
				: (id ?? (isRecord(info) ? Reflect.get(info, "id") : undefined)),
		method: Reflect.get(value, "method"),
		url: originalUrl
			? originalUrl
			: typeof pathValue === "string"
				? pathValue
				: isRecord(url)
					? (Reflect.get(url, "path") ?? url)
					: url,
		...(query ? { query } : {}),
		...(params ? { params } : {}),
		headers: Reflect.get(value, "headers"),
		remoteAddress: isRecord(connection)
			? Reflect.get(connection, "remoteAddress")
			: undefined,
		remotePort: isRecord(connection)
			? Reflect.get(connection, "remotePort")
			: undefined,
	};
}

/** An HTTP response as upstream's `res` serializer writes it: status and headers. */
export function serializeResponse(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const getHeaders = Reflect.get(value, "getHeaders");
	return {
		statusCode: Reflect.get(value, "headersSent")
			? Reflect.get(value, "statusCode")
			: null,
		headers:
			typeof getHeaders === "function"
				? Reflect.apply(getHeaders, value, [])
				: Reflect.get(value, "_headers"),
	};
}

export const stdSerializers: {
	err: (value: unknown) => unknown;
	req: (value: unknown) => unknown;
	res: (value: unknown) => unknown;
} = {
	err: (value) => serializeError(value),
	req: serializeRequest,
	res: serializeResponse,
};

/**
 * Upstream's time functions, for `timestamp`: each returns the `,"time":…`
 * fragment a JSON line carries.
 */
export const stdTimeFunctions: {
	epochTime: () => string;
	unixTime: () => string;
	isoTime: () => string;
	nullTime: () => string;
} = {
	epochTime: () => `,"time":${Date.now()}`,
	unixTime: () => `,"time":${Math.round(Date.now() / 1000)}`,
	isoTime: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
	nullTime: () => "",
};
