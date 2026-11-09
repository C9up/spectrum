import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileChannel } from "../../src/channels/FileChannel.js";
import type { LogEntry } from "../../src/types.js";

function entry(message: string): LogEntry {
	return {
		timestamp: "2026-05-04T00:00:00.000Z",
		level: "info",
		module: "test",
		message,
	};
}

const channelUrl = pathToFileURL(
	path.resolve(import.meta.dirname, "../../src/channels/FileChannel.ts"),
).href;

/**
 * The child runs the TypeScript source under Node's own type stripping; the
 * hook maps the sources' `.js` specifiers onto their `.ts` files.
 */
const RESOLVE_TS = `export async function resolve(specifier, context, next) {
	try { return await next(specifier, context) }
	catch (error) {
		if (specifier.endsWith('.js')) return next(specifier.slice(0, -3) + '.ts', context)
		throw error
	}
}`;

function runChild(body: string): { status: number | null; stderr: string } {
	const script = `
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(RESOLVE_TS)}))
const { FileChannel } = await import(${JSON.stringify(channelUrl)})
${body}
`;
	const result = spawnSync(
		process.execPath,
		["--no-warnings", "--input-type=module", "-e", script],
		{ encoding: "utf8", timeout: 20_000 },
	);
	return { status: result.status, stderr: result.stderr };
}

describe("spectrum > FileChannel flushes on process exit", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-exit-"));
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("keeps a fatal line logged right before process.exit()", () => {
		const file = path.join(dir, "logs", "app.log");
		const { status, stderr } = runChild(`
const channel = new FileChannel({ path: ${JSON.stringify(file)} })
channel.write({ timestamp: 't', level: 'fatal', module: 'app', message: 'unrecoverable: database gone' })
process.exit(1)
`);
		expect(stderr).toBe("");
		expect(status).toBe(1);
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("unrecoverable: database gone");
	});

	it("keeps every line of a burst, in order, when the process exits mid-write", () => {
		const file = path.join(dir, "app.log");
		const { status } = runChild(`
const channel = new FileChannel({ path: ${JSON.stringify(file)} })
for (let i = 0; i < 5000; i++) {
	channel.write({ timestamp: 't', level: 'info', module: 'app', message: 'line-' + i })
}
setImmediate(() => process.exit(0))
`);
		expect(status).toBe(0);
		const messages = fs
			.readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const parsed: unknown = JSON.parse(line);
				return typeof parsed === "object" && parsed !== null && "msg" in parsed
					? parsed.msg
					: undefined;
			});
		expect(new Set(messages).size).toBe(5000);
		expect(messages).toContain("line-0");
		expect(messages).toContain("line-4999");
	});

	it("does not keep the process alive or write anything once closed", () => {
		const file = path.join(dir, "app.log");
		const { status } = runChild(`
const channel = new FileChannel({ path: ${JSON.stringify(file)} })
channel.write({ timestamp: 't', level: 'info', module: 'app', message: 'kept' })
await channel.close()
channel.write({ timestamp: 't', level: 'info', module: 'app', message: 'after-close' })
`);
		expect(status).toBe(0);
		const body = fs.readFileSync(file, "utf8");
		expect(body).toContain("kept");
		expect(body).not.toContain("after-close");
	});
});

describe("spectrum > FileChannel memory is bounded", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "spectrum-bound-"));
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("drops lines beyond maxBufferBytes and says how many", async () => {
		const file = path.join(dir, "app.log");
		const channel = new FileChannel({ path: file, maxBufferBytes: 4096 });
		// One synchronous burst: nothing can reach the file before it ends, so
		// everything past the cap has to be refused rather than held.
		for (let i = 0; i < 1000; i++) channel.write(entry(`line-${i}`));
		await channel.close();

		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		const kept = lines.filter((line) => line.includes('"line-'));
		const notice = lines.find((line) => line.includes("dropped"));
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.join("\n").length).toBeLessThanOrEqual(4096);
		expect(notice).toBeDefined();
		const dropped = Number(/dropped (\d+)/.exec(notice ?? "")?.[1]);
		expect(dropped + kept.length).toBe(1000);
	});

	it("accepts lines again once the destination has caught up", async () => {
		const file = path.join(dir, "app.log");
		const channel = new FileChannel({ path: file, maxBufferBytes: 4096 });
		for (let i = 0; i < 1000; i++) channel.write(entry(`burst-${i}`));
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		channel.write(entry("after-drain"));
		await channel.close();
		expect(fs.readFileSync(file, "utf8")).toContain("after-drain");
	});

	it("rejects a maxBufferBytes that is not a positive integer", () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				() =>
					new FileChannel({
						path: path.join(dir, "x.log"),
						maxBufferBytes: bad,
					}),
			).toThrow(/maxBufferBytes/);
		}
	});
});
