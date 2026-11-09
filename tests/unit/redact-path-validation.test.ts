import { describe, expect, it } from "vitest";
import { Logger } from "../../src/Logger.js";
import { parseRedactPath } from "../../src/redact.js";
import type { LogConfig } from "../../src/types.js";

function construct(redact: LogConfig["redact"]): () => Logger {
	return () => new Logger({ level: "info", channels: [], redact });
}

describe("spectrum > malformed redact paths fail at construction", () => {
	for (const bad of [
		"password,token",
		"",
		"a..b",
		"a[b",
		"a]b",
		"a[b]]",
		"headers['x,y']",
		'headers["set-cookie"',
	]) {
		it(`rejects ${JSON.stringify(bad)}`, () => {
			expect(construct([bad])).toThrow(
				expect.objectContaining({ code: "E_SPECTRUM_INVALID_REDACT_PATH" }),
			);
			expect(construct({ paths: [bad] })).toThrow(/Invalid redaction path/);
		});
	}

	it("rejects a path that is not a string", () => {
		// What an untyped (JavaScript) config can hand over.
		expect(() => Reflect.construct(Logger, [{ redact: ["ok", 42] }])).toThrow(
			expect.objectContaining({ code: "E_SPECTRUM_INVALID_REDACT_PATH" }),
		);
	});

	it("rejects options whose paths are not an array", () => {
		expect(() =>
			Reflect.construct(Logger, [{ redact: { paths: "password" } }]),
		).toThrow(
			expect.objectContaining({ code: "E_SPECTRUM_INVALID_REDACT_PATH" }),
		);
	});

	it("keeps accepting every valid form", () => {
		for (const good of [
			"password",
			"req.headers.authorization",
			"*.password",
			"users[*].token",
			'headers["set-cookie"]',
			'a["b.c"].d',
		]) {
			expect(construct([good])).not.toThrow();
		}
		expect(parseRedactPath('headers["set-cookie"]')).toEqual([
			"headers",
			"set-cookie",
		]);
	});
});
