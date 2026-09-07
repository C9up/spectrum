/**
 * A channel that cannot close is lost log, and shutdown must say so.
 *
 * `allSettled` is there so one channel failing does not strand the others —
 * that part is right. The results were then thrown away, so a channel that
 * could not flush disappeared without a word, during the one phase where the
 * lines being lost are the ones explaining why the process is going down.
 */
import { describe, expect, it } from "vitest";
import SpectrumProvider from "../../src/SpectrumProvider.js";

/** The slice of a host the provider reads: a container that caches. */
function host(channels: unknown[]) {
	const bindings = new Map<unknown, () => unknown>();
	const built = new Map<unknown, unknown>();
	return {
		container: {
			singleton(token: unknown, factory: () => unknown) {
				bindings.set(token, factory);
			},
			async resolve(token: unknown): Promise<never> {
				if (!built.has(token)) {
					const factory = bindings.get(token);
					if (!factory) throw new Error(`unbound: ${String(token)}`);
					built.set(token, await factory());
				}
				return built.get(token) as never;
			},
			has: (token: unknown) => bindings.has(token),
		},
		config: {
			get: (key: string): unknown =>
				key === "logger" ? { channels } : undefined,
		},
	};
}

/** Capture stderr for the duration of one call. */
async function stderrDuring(run: () => Promise<void>): Promise<string> {
	const written: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		written.push(String(chunk));
		return true;
	};
	try {
		await run();
	} finally {
		process.stderr.write = original;
	}
	return written.join("");
}

describe("spectrum > a channel that fails to close", () => {
	it("is reported, not swallowed", async () => {
		const failing = {
			write() {},
			close: () => Promise.reject(new Error("disk full")),
		};
		const provider = new SpectrumProvider(host([failing]) as never);
		provider.register();
		await provider.boot();

		const output = await stderrDuring(() => provider.shutdown());

		expect(output).toContain("failed to close");
		expect(output).toContain("disk full");
	});

	it("still closes the others when one fails", async () => {
		let closed = false;
		const failing = {
			write() {},
			close: () => Promise.reject(new Error("disk full")),
		};
		const healthy = {
			write() {},
			close: async () => {
				closed = true;
			},
		};
		const provider = new SpectrumProvider(host([failing, healthy]) as never);
		provider.register();
		await provider.boot();

		await stderrDuring(() => provider.shutdown());

		expect(closed).toBe(true);
	});

	it("says nothing when every channel closes", async () => {
		const healthy = { write() {}, close: async () => {} };
		const provider = new SpectrumProvider(host([healthy]) as never);
		provider.register();
		await provider.boot();

		expect(await stderrDuring(() => provider.shutdown())).toBe("");
	});
});
