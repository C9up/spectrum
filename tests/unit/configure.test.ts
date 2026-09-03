import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { configure } from "../../src/configure.js";
import { Logger } from "../../src/Logger.js";
import SpectrumProvider, {
	type SpectrumAppContext,
} from "../../src/SpectrumProvider.js";
import type { LogChannel, LogEntry } from "../../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The content `configure` writes for `config/logger.ts`. */
async function generatedConfig(): Promise<string> {
	const files: Array<{ path: string; content: string }> = [];
	await configure({
		async addProvider() {},
		async addEnvVars() {},
		async writeFile(filePath, content) {
			files.push({ path: filePath, content });
		},
	});
	const written = files[0];
	if (!written) throw new Error("configure wrote nothing");
	return written.content;
}

class Capture implements LogChannel {
	name = "capture";
	entries: LogEntry[] = [];
	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

const scratch: string[] = [];

afterEach(() => {
	for (const file of scratch.splice(0)) fs.rmSync(file, { force: true });
});

/**
 * Load the generated config as a module.
 *
 * The package does not resolve its own name from inside itself, so the one
 * import in the stub is pointed at the source it names. Everything else is
 * executed exactly as it was written.
 */
async function loadGeneratedConfig(): Promise<unknown> {
	const source = (await generatedConfig()).replace(
		"'@c9up/spectrum'",
		JSON.stringify(path.join(here, "../../src/index.ts")),
	);
	const file = path.join(here, `__generated-logger-${process.pid}.ts`);
	scratch.push(file);
	fs.writeFileSync(file, source);
	const module: { default?: unknown } = await import(file);
	return module.default;
}

describe("spectrum > configure", () => {
	it("registers the provider and writes config/logger.ts", async () => {
		const providers: string[] = [];
		const files: Array<{ path: string; content: string }> = [];

		await configure({
			async addProvider(importPath) {
				providers.push(importPath);
			},
			async addEnvVars() {},
			async writeFile(path, content) {
				files.push({ path, content });
			},
		});

		expect(providers).toEqual(["@c9up/spectrum/provider"]);
		expect(files).toHaveLength(1);
		expect(files[0]?.path).toBe("config/logger.ts");
		expect(files[0]?.content).toContain("@c9up/spectrum");
		expect(files[0]?.content).toContain("level:");
	});

	it("generates a config the provider can actually drive", async () => {
		const channel = new Capture();

		// The stub is what a new application starts from, so what it declares
		// has to survive the provider's normalisation. Asserting the file merely
		// mentions "level:" would have passed just as happily on a config whose
		// declared output the provider replaced with a console.
		const logger = await loggerFrom(await loadGeneratedConfig(), channel);
		logger.info("from the generated config");

		expect(channel.entries).toHaveLength(1);
		expect(channel.entries[0]?.name).toBe("app");
	});
});

/**
 * Run the generated config through the provider, with the declared targets
 * swapped for a channel the test can read.
 */
async function loggerFrom(
	config: unknown,
	channel: LogChannel,
): Promise<Logger> {
	if (typeof config !== "object" || config === null) {
		throw new Error("the generated config did not export an object");
	}
	const loggers = "loggers" in config ? config.loggers : undefined;
	if (typeof loggers !== "object" || loggers === null) {
		throw new Error("the generated config declares no loggers");
	}
	const declared = "app" in loggers ? loggers.app : undefined;
	if (typeof declared !== "object" || declared === null) {
		throw new Error("the generated config declares no `app` logger");
	}
	const withChannel = {
		...config,
		loggers: { app: { ...declared, channels: [channel] } },
	};

	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	const app: SpectrumAppContext = {
		container: {
			singleton(token, factory) {
				bindings.set(token, factory);
			},
			async resolve<T = unknown>(token: unknown): Promise<T> {
				const cached = cache.get(token);
				if (cached !== undefined) return asType<T>(cached);
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = await factory();
				cache.set(token, value);
				return asType<T>(value);
			},
		},
		config: {
			get<T = unknown>(key: string): T | undefined {
				return key === "logger" ? asType<T>(withChannel) : undefined;
			},
		},
	};

	new SpectrumProvider(app).register();
	return app.container.resolve<Logger>(Logger);
}

/** The container contract is untyped by design; admitted once, here. */
function asType<T>(value: unknown): T {
	return value as T;
}
