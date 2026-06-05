import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			thresholds: {
				lines: 74,
				statements: 71,
				branches: 73,
				functions: 82,
			},
		},
	},
});
