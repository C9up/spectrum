import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/index.js";

describe("spectrum > errors", () => {
	it("the entry exports every error as one `errors` namespace", () => {
		const error = new errors.E_SPECTRUM_UNKNOWN_LOGGER(["audit", "app, http"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_SPECTRUM_UNKNOWN_LOGGER);
		expect(error.code).toBe("E_SPECTRUM_UNKNOWN_LOGGER");
		expect(error.status).toBe(500);
		expect(error.message).toBe(
			'[spectrum] Unknown logger "audit". Registered: app, http',
		);
	});

	it("a constant message needs no argument", () => {
		const cause = new Error("boom");
		const error = new errors.E_SPECTRUM_NOT_BOOTED([], { cause });
		expect(error.code).toBe("E_SPECTRUM_NOT_BOOTED");
		expect(error.message).toMatch(/^\[spectrum\] Logger singleton accessed/);
		expect(error.cause).toBe(cause);
	});
});
