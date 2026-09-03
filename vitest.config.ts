import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			// Set to just under what the suite actually reaches, so the gate can
			// only be crossed downwards on purpose. It was pinned well below the
			// real figures and never run by CI, which is the same as absent.
			thresholds: {
				lines: 90,
				statements: 88,
				branches: 80,
				functions: 92,
			},
		},
	},
});
