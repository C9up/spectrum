interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
}

export async function configure(codemods: Codemods): Promise<void> {
	await codemods.addProvider("@c9up/spectrum/provider");
	await codemods.writeFile(
		"config/logger.ts",
		`import { ConsoleChannel, defineConfig } from '@c9up/spectrum'

export default defineConfig({
  level: process.env.LOG_LEVEL ?? 'info',
  // Channels are LogChannel instances. Add a FileChannel for disk logs:
  //   new FileChannel({ path: 'storage/logs/app.log' })
  channels: [new ConsoleChannel('pretty')],
})
`,
	);
}
