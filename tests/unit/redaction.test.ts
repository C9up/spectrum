/**
 * Redaction is the one feature of a logger whose failure is invisible: the
 * config declares the secret censored, the log line is written, and nobody
 * looks again. Every expectation here was read off `fast-redact` — the module
 * upstream hands its `redact.paths` to — rather than derived from this
 * implementation.
 */
import { describe, expect, it } from "vitest";
import { Logger } from "../../src/Logger.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

class Capture implements LogChannel {
	name = "capture";
	entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

/** Log one merging object through `paths` and hand back what was written. */
function redacted(paths: string[], merging: Record<string, unknown>): LogEntry {
	const channel = new Capture();
	new Logger({ level: "info", channels: [channel], redact: paths }).info(
		merging,
		"line",
	);
	const entry = channel.entries[0];
	if (!entry) throw new Error("nothing was logged");
	return entry;
}

describe("spectrum > redaction paths", () => {
	it("censors through a wildcard segment", () => {
		// `*.password` is the shape every "hide it wherever it turns up" config
		// is written in. Reading it as a literal key named `*` matched nothing
		// and wrote both passwords out in full.
		const entry = redacted(["*.password"], {
			db: { password: "p1" },
			cache: { password: "p2" },
			keep: 1,
		});

		expect(entry.db).toEqual({ password: "[Redacted]" });
		expect(entry.cache).toEqual({ password: "[Redacted]" });
		expect(entry.keep).toBe(1);
	});

	it("reaches into a list", () => {
		const entry = redacted(["users[*].token"], {
			users: [{ token: "t1" }, { token: "t2", id: 9 }],
		});

		expect(entry.users).toEqual([
			{ token: "[Redacted]" },
			{ token: "[Redacted]", id: 9 },
		]);
	});

	it("reads bracket notation as the key it names", () => {
		// The only way to write a key with a dash in it.
		const entry = redacted(['headers["set-cookie"]'], {
			headers: { "set-cookie": "sid=1" },
		});

		expect(entry.headers).toEqual({ "set-cookie": "[Redacted]" });
	});

	it("censors every value under a trailing wildcard", () => {
		const entry = redacted(["creds.*"], { creds: { user: "u", pass: "p" } });

		expect(entry.creds).toEqual({ user: "[Redacted]", pass: "[Redacted]" });
	});

	it("still censors a plain dot-path", () => {
		const entry = redacted(["req.headers.authorization"], {
			req: { headers: { authorization: "Bearer x", accept: "*/*" } },
		});

		expect(entry.req).toEqual({
			headers: { authorization: "[Redacted]", accept: "*/*" },
		});
	});

	it("leaves an object alone when the path runs into a non-object", () => {
		const entry = redacted(["a.b"], { a: 1 });

		expect(entry.a).toBe(1);
	});

	it("leaves an object alone when the path names nothing", () => {
		const entry = redacted(["missing.deep.path"], { other: 1 });

		expect(entry.other).toBe(1);
		expect(entry.missing).toBeUndefined();
	});

	it("does not answer for a name every object inherits", () => {
		// Named deviation from upstream, which assigns a single-segment path
		// unconditionally and so hands back an entry carrying a censored
		// `toString` the application never logged. A redacted field is a claim
		// that there was something there to hide.
		const entry = redacted(["toString"], { a: 1 });

		expect(Object.hasOwn(entry, "toString")).toBe(false);
		expect(entry.a).toBe(1);
	});

	it("honours a custom censor", () => {
		const channel = new Capture();
		new Logger({
			level: "info",
			channels: [channel],
			redact: { paths: ["*.password"], censor: "***" },
		}).info({ db: { password: "p1" } }, "line");

		expect(channel.entries[0]?.db).toEqual({ password: "***" });
	});

	it("never mutates what the caller passed in", () => {
		const merging = { db: { password: "p1" } };
		redacted(["*.password"], merging);

		expect(merging.db.password).toBe("p1");
	});
});
