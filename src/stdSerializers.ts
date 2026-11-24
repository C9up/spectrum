/**
 * The standard serializers, in the shapes upstream's `stdSerializers` write:
 * `err` for errors, `req` and `res` for an HTTP request and response — Node's,
 * or the framework's, whose fields are methods.
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
 * Call `target[name]()` when it is a method; `undefined` when it is not, or
 * when it throws — a serializer must not take the line down with it.
 */
function callMethod(target: object, name: string): unknown {
	const method: unknown = Reflect.get(target, name);
	if (typeof method !== "function") return undefined;
	try {
		return Reflect.apply(method, target, []);
	} catch {
		return undefined;
	}
}

/** A copy of a record with at least one key, else `undefined`. */
function nonEmpty(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
	return { ...value };
}

/**
 * A request whose fields are methods (`method()`, `url()`, `headers()`), as
 * the framework's own request is. Recognised by its shape, so spectrum does
 * not depend on the framework.
 */
function isMethodRequest(value: object): boolean {
	return (
		typeof Reflect.get(value, "method") === "function" &&
		typeof Reflect.get(value, "url") === "function" &&
		typeof Reflect.get(value, "headers") === "function"
	);
}

/**
 * The headers of a method request: from its `serializeSafe()` view when it
 * offers one (credential headers already blanked by the request itself),
 * else from `headers()`. A plain copy either way, so the redaction paths
 * written against `req.headers.*` reach them.
 */
function methodRequestHeaders(value: object): Record<string, unknown> {
	const safe = callMethod(value, "serializeSafe");
	const safeHeaders = isRecord(safe) ? Reflect.get(safe, "headers") : undefined;
	if (isRecord(safeHeaders)) return { ...safeHeaders };
	const headers = callMethod(value, "headers");
	return isRecord(headers) ? { ...headers } : {};
}

/**
 * NAMED DEVIATION — upstream's `req` serializer knows only Node's
 * `IncomingMessage`, whose fields are properties. On the framework's request
 * they are methods: read as properties they were functions, JSON left them
 * out, and the line said `"req":{}`. The same fields are written here by
 * calling the methods. `url` is the path and the query string is written
 * apart, parsed, so a redaction path can reach a token it carries
 * (`req.query.token`) where it could not reach into a URL string. Never the
 * body and never the cookie map: they are not part of the shape.
 */
function serializeMethodRequest(value: object): Record<string, unknown> {
	const query = nonEmpty(callMethod(value, "qs"));
	const params = nonEmpty(callMethod(value, "params"));
	return {
		id: callMethod(value, "id"),
		method: callMethod(value, "method"),
		url: callMethod(value, "url"),
		...(query ? { query } : {}),
		...(params ? { params } : {}),
		headers: methodRequestHeaders(value),
		remoteAddress: callMethod(value, "ip"),
	};
}

/**
 * An HTTP request as upstream's `req` serializer writes it: id, method, url,
 * query, params, headers and the remote address. Every header is written as
 * it is, `cookie` and `authorization` included — censoring them is what
 * `redact` is for, and the generated config lists them. The framework's own
 * request, whose fields are methods, is read through those methods.
 */
export function serializeRequest(value: unknown): unknown {
	if (!isRecord(value)) return value;
	if (isMethodRequest(value)) return serializeMethodRequest(value);
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

/**
 * An HTTP response as upstream's `res` serializer writes it: status and
 * headers. The framework's response has no `statusCode` property: its
 * `getStatus()` is read instead (it is set on the response before it is
 * sent, so it is written whether or not the headers went out).
 */
export function serializeResponse(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const getHeaders = Reflect.get(value, "getHeaders");
	const getStatus = Reflect.get(value, "getStatus");
	return {
		statusCode:
			typeof getStatus === "function"
				? callMethod(value, "getStatus")
				: Reflect.get(value, "headersSent")
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
