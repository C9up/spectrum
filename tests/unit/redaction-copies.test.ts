import { describe, expect, it } from "vitest";
import { Logger } from "../../src/Logger.js";
import { stringifyRecord } from "../../src/stringify.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

class Capture implements LogChannel {
	readonly name = "capture";
	readonly entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

/** Log `merging` through `paths` and hand back the JSON line as written. */
function line(paths: string[], merging: Record<string, unknown>): string {
	const capture = new Capture();
	new Logger({ level: "info", channels: [capture], redact: paths }).info(
		merging,
		"line",
	);
	const [entry] = capture.entries;
	if (entry === undefined) throw new Error("nothing logged");
	return stringifyRecord(entry);
}

class User {
	email = "a@b.c";
	passwordHash = "$argon2id$secret";
	apiToken = "tok_live";
	toJSON(): Record<string, unknown> {
		return { email: this.email };
	}
}

describe("spectrum > redaction keeps what the redacted object is", () => {
	it("keeps a model's toJSON when a path matches inside it", () => {
		const out = line(["user.apiToken"], { user: new User() });
		expect(out).toContain('"user":{"email":"a@b.c"}');
		expect(out).not.toContain("argon2id");
		expect(out).not.toContain("tok_live");
	});

	it("still censors a field the toJSON exposes", () => {
		class Exposing {
			token = "tok_live";
			toJSON(): Record<string, unknown> {
				return { token: this.token };
			}
		}
		const out = line(["thing.token"], { thing: new Exposing() });
		expect(out).toContain('"thing":{"token":"[Redacted]"}');
	});

	it("keeps the prototype through a wildcard segment", () => {
		const out = line(["*.apiToken"], {
			user: new User(),
			other: { apiToken: "x" },
		});
		expect(out).toContain('"user":{"email":"a@b.c"}');
		expect(out).toContain('"other":{"apiToken":"[Redacted]"}');
	});

	it("writes a Date under a wildcard path as an ISO string", () => {
		const at = new Date("2026-01-02T03:04:05.000Z");
		const out = line(["meta.*.secret"], {
			meta: { at, creds: { secret: "s" } },
		});
		expect(out).toContain('"at":"2026-01-02T03:04:05.000Z"');
		expect(out).toContain('"secret":"[Redacted]"');
	});

	it("does not run a prototype setter while copying", () => {
		let setterRan = false;
		class Guarded {
			secret = "s";
			plain = "p";
			set trap(_value: unknown) {
				setterRan = true;
			}
		}
		const guarded = new Guarded();
		Object.defineProperty(guarded, "trap", {
			value: 1,
			enumerable: true,
			writable: true,
		});
		const out = line(["g.secret"], { g: guarded });
		expect(setterRan).toBe(false);
		expect(out).toContain('"secret":"[Redacted]"');
		expect(out).toContain('"trap":1');
	});

	it("leaves the caller's object untouched", () => {
		const user = new User();
		line(["user.apiToken"], { user });
		expect(user.apiToken).toBe("tok_live");
	});
});
