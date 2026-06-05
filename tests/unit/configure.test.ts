import { describe, expect, it } from "vitest";
import { configure } from "../../src/configure.js";

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
});
