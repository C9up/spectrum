import { Request, Response } from "@c9up/ream";
import { describe, expect, it } from "vitest";
import { jsonLine } from "../../src/jsonLine.js";
import { Logger } from "../../src/Logger.js";
import { stdSerializers } from "../../src/stdSerializers.js";
import type { LogChannel, LogConfig, LogEntry } from "../../src/types.js";

const GENERATED_PATHS = [
	"req.headers.authorization",
	"req.headers.cookie",
	'res.headers["set-cookie"]',
];

function capture(config: Partial<LogConfig>): {
	logger: Logger;
	lines: string[];
} {
	const lines: string[] = [];
	const channel: LogChannel = {
		name: "capture",
		write: (entry: LogEntry) => void lines.push(jsonLine(entry)),
	};
	return {
		lines,
		logger: new Logger({ level: "info", channels: [channel], ...config }),
	};
}

function parsed(line: string | undefined): Record<string, unknown> {
	const value: unknown = JSON.parse(line ?? "null");
	if (typeof value !== "object" || value === null) throw new Error("no line");
	return { ...value };
}

function loginRequest(): Request {
	const request = new Request(
		{
			method: "POST",
			path: "/login",
			query: "",
			headers: {
				authorization: "Bearer s3cr3t-api-token",
				cookie: "ream-session=SESSIONID123",
				"content-type": "application/json",
			},
			body: JSON.stringify({ email: "alice@example.com", password: "hunter2" }),
		},
		{},
	);
	request.setInitialBody({ email: "alice@example.com", password: "hunter2" });
	return request;
}

describe("stdSerializers.req on the framework's request", () => {
	it("writes method, url and headers, never the body or the cookie map", () => {
		const out = stdSerializers.req(loginRequest());
		expect(out).toEqual({
			id: undefined,
			method: "POST",
			url: "/login",
			// The request blanks its own credential headers in its safe view.
			headers: {
				authorization: "[redacted]",
				cookie: "[redacted]",
				"content-type": "application/json",
			},
			remoteAddress: loginRequest().ip(),
		});
	});

	it("under the generated paths, the line carries no credential and no body", () => {
		const { logger, lines } = capture({
			redact: { paths: GENERATED_PATHS },
			serializers: { req: stdSerializers.req },
		});
		logger.info("login attempt", { req: loginRequest() });
		const line = lines[0] ?? "";
		for (const secret of ["s3cr3t-api-token", "SESSIONID123", "hunter2"]) {
			expect(line).not.toContain(secret);
		}
		const req = parsed(line).req;
		expect(req).toMatchObject({
			method: "POST",
			url: "/login",
			headers: { authorization: "[Redacted]", cookie: "[Redacted]" },
		});
	});

	it("reads a request without a safe view through headers(), and survives a throwing method", () => {
		const request = {
			method: () => "GET",
			url: () => "/orders",
			headers: () => ({ authorization: "Bearer t", accept: "*/*" }),
			qs: () => ({}),
			params: () => ({ id: "3" }),
			ip: () => {
				throw new Error("no socket");
			},
		};
		expect(stdSerializers.req(request)).toEqual({
			id: undefined,
			method: "GET",
			url: "/orders",
			params: { id: "3" },
			headers: { authorization: "Bearer t", accept: "*/*" },
			remoteAddress: undefined,
		});
	});

	it("a headers() that answers no object gives an empty header map", () => {
		const out = stdSerializers.req({
			method: () => "GET",
			url: () => "/",
			headers: () => null,
		});
		expect(out).toMatchObject({ headers: {} });
	});

	it("still reads a Node-shaped request through its properties", () => {
		expect(
			stdSerializers.req({
				method: "GET",
				url: "/a?b=1",
				headers: { accept: "*/*" },
				socket: { remoteAddress: "10.0.0.1", remotePort: 5000 },
			}),
		).toEqual({
			id: undefined,
			method: "GET",
			url: "/a?b=1",
			headers: { accept: "*/*" },
			remoteAddress: "10.0.0.1",
			remotePort: 5000,
		});
	});
});

describe("stdSerializers.res on the framework's response", () => {
	it("writes the status set on the response and its headers", () => {
		const response = new Response();
		response.status(201);
		response.plainCookie("session", "new");
		const { logger, lines } = capture({
			redact: { paths: GENERATED_PATHS },
			serializers: { res: stdSerializers.res },
		});
		logger.info("sent", { res: response });
		const res = parsed(lines[0]).res;
		expect(res).toMatchObject({
			statusCode: 201,
			headers: { "set-cookie": "[Redacted]" },
		});
	});

	it("keeps the Node rule for a response with no getStatus()", () => {
		expect(
			stdSerializers.res({ statusCode: 500, headersSent: false, _headers: {} }),
		).toEqual({ statusCode: null, headers: {} });
	});
});

describe("redaction applies to what toJSON() writes", () => {
	it("censors a header of a raw request logged with no serializer", () => {
		const { logger, lines } = capture({ redact: { paths: GENERATED_PATHS } });
		logger.info({ req: loginRequest() }, "login attempt");
		const line = lines[0] ?? "";
		expect(line).not.toContain("s3cr3t-api-token");
		expect(line).not.toContain("ream-session=SESSIONID123");
		expect(parsed(line).req).toMatchObject({
			method: "POST",
			headers: { authorization: "[Redacted]", cookie: "[Redacted]" },
		});
	});

	it("reaches a key that exists only in the toJSON view, with remove and a wildcard", () => {
		class Session {
			readonly #token = "tok_live";
			toJSON(): Record<string, unknown> {
				return { token: this.#token, user: 1 };
			}
		}
		const { logger, lines } = capture({
			redact: { paths: ["session.token", "*.user"], remove: true },
		});
		logger.info("seen", { session: new Session() });
		expect(parsed(lines[0]).session).toEqual({});
	});

	it("passes through a node whose toJSON throws or answers a primitive", () => {
		const { logger, lines } = capture({ redact: ["at.secret", "bad.secret"] });
		const bad = {
			secret: "s",
			toJSON(): never {
				throw new Error("cannot");
			},
		};
		logger.info("seen", { at: new Date(0), bad });
		const entry = parsed(lines[0]);
		expect(entry.at).toBe("1970-01-01T00:00:00.000Z");
		expect(lines[0]).not.toContain('"s"');
	});
});
