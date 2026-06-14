/**
 * File logging channel — writes log entries to a file as JSON lines.
 *
 * Uses a non-blocking WriteStream with an internal buffer. Rotation is
 * scheduled via queueMicrotask to avoid blocking the event loop on the
 * HTTP hot path.
 *
 * @implements MISS-14, MISS-15
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { LogChannel, LogEntry } from "../types.js";

export interface FileChannelConfig {
	path: string;
	maxSizeBytes?: number; // default 10MB
	maxFiles?: number; // default 5
}

export class FileChannel implements LogChannel {
	name = "file";
	#filePath: string;
	#maxSize: number;
	#maxFiles: number;
	#stream: fs.WriteStream | null = null;
	#currentSize = 0;
	#dirReady = false;
	#rotating = false;
	#pending: string[] = [];

	constructor(config: FileChannelConfig) {
		this.#filePath = config.path;
		this.#maxSize = config.maxSizeBytes ?? 10 * 1024 * 1024;
		this.#maxFiles = config.maxFiles ?? 5;
	}

	write(entry: LogEntry): void {
		const line = `${JSON.stringify(entry)}\n`;
		const bytes = Buffer.byteLength(line, "utf8");

		if (this.#rotating) {
			this.#pending.push(line);
			return;
		}

		if (!this.#stream) {
			try {
				this.#openStream();
			} catch {
				process.stderr.write(
					`[Spectrum] FileChannel: failed to open '${this.#filePath}'\n`,
				);
				return;
			}
			// A prior failed rotation strands buffered lines while #stream is
			// null (the rotation's #flushPending early-returns on no stream).
			// Now that we've reopened, drain them — in order, before the new
			// line — instead of losing them until the next rotation happens to
			// fire. #flushPending may itself trigger a rotation if a buffered
			// line overflows, so re-check before writing the current line.
			this.#flushPending();
			if (this.#rotating) {
				this.#pending.push(line);
				return;
			}
		}

		if (this.#currentSize + bytes > this.#maxSize) {
			this.#pending.push(line);
			this.#scheduleRotation();
			return;
		}

		if (this.#stream) {
			this.#stream.write(line);
			this.#currentSize += bytes;
		}
	}

	#openStream(): void {
		// mkdirSync + statSync only on first open (boot) — never on the hot path.
		// The fast write path goes straight through this.#stream.write() (non-blocking).
		if (!this.#dirReady) {
			const dir = path.dirname(this.#filePath);
			fs.mkdirSync(dir, { recursive: true });
			this.#dirReady = true;
		}
		try {
			this.#currentSize = fs.statSync(this.#filePath).size;
		} catch {
			this.#currentSize = 0;
		}
		this.#stream = fs.createWriteStream(this.#filePath, { flags: "a" });
		this.#stream.on("error", (err) => {
			process.stderr.write(
				`[Spectrum] FileChannel stream error: ${err.message}\n`,
			);
		});
	}

	#scheduleRotation(): void {
		if (this.#rotating) return;
		this.#rotating = true;
		queueMicrotask(() => {
			this.#rotate().finally(() => {
				this.#rotating = false;
				this.#flushPending();
			});
		});
	}

	async #rotate(): Promise<void> {
		try {
			await this.#closeStream();

			const oldest = `${this.#filePath}.${this.#maxFiles - 1}`;
			await fsp.rm(oldest, { force: true });

			for (let i = this.#maxFiles - 2; i >= 1; i--) {
				const from = i === 1 ? this.#filePath : `${this.#filePath}.${i}`;
				const to = `${this.#filePath}.${i + 1}`;
				try {
					await fsp.rename(from, to);
				} catch {
					// File doesn't exist — skip
				}
			}

			try {
				await fsp.rename(this.#filePath, `${this.#filePath}.1`);
			} catch {
				// Nothing to rotate
			}

			this.#openStream();
		} catch {
			try {
				this.#openStream();
			} catch {
				process.stderr.write(
					`[Spectrum] FileChannel: rotation failed, logging suspended for '${this.#filePath}'\n`,
				);
				this.#stream = null;
			}
		}
	}

	#flushPending(): void {
		if (!this.#stream) return;
		while (this.#pending.length > 0) {
			const line = this.#pending.shift();
			if (!line) continue;
			const bytes = Buffer.byteLength(line, "utf8");
			if (this.#currentSize + bytes > this.#maxSize) {
				this.#pending.unshift(line);
				this.#scheduleRotation();
				return;
			}
			this.#stream.write(line);
			this.#currentSize += bytes;
		}
	}

	async #closeStream(): Promise<void> {
		if (!this.#stream) return;
		const stream = this.#stream;
		this.#stream = null;
		return new Promise((resolve) => {
			stream.end(() => resolve());
		});
	}

	close(): void {
		if (this.#stream) {
			this.#stream.end();
			this.#stream = null;
		}
	}
}
