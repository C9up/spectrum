/**
 * File logging channel — writes log entries to a file as JSON lines.
 *
 * `write()` never touches the disk: it queues the line and returns. One
 * asynchronous pump opens the file, writes the queue in order, and rotates it
 * when the next line would cross `maxSizeBytes`, so the HTTP hot path never
 * waits on the filesystem.
 *
 * Two promises hold that together, both as pino's file destination keeps them:
 * a line accepted before the process exits is on disk after it (the queue is
 * written synchronously on `exit`), and a destination that stops keeping up
 * costs bounded memory (past `maxBufferBytes` lines are dropped and counted,
 * and the count is written once the queue drains).
 *
 * @implements MISS-14, MISS-15
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { SpectrumError } from "../errors.js";
import { stringifyLimitsFor, stringifyRecord } from "../stringify.js";
import type { LogChannel, LogEntry } from "../types.js";

export interface FileChannelConfig {
	/** The file to append to (created, with its directory, if missing). */
	path?: string;
	/**
	 * An already-open descriptor to write to instead of a path — what a
	 * `destination: 3` target names. Never rotated, and left open on close:
	 * the channel did not open it.
	 */
	fd?: number;
	/** Rotate before the live file would grow past this. Default 10 MiB. */
	maxSizeBytes?: number;
	/** Files kept, the live one included. Default 5. */
	maxFiles?: number;
	/**
	 * Bytes accepted but not yet written that the channel will hold. Past it,
	 * new lines are dropped and counted. Default 16 MiB.
	 */
	maxBufferBytes?: number;
}

const openFd = promisify(fs.open);
const writeFd = promisify(fs.write);
const closeFd = promisify(fs.close);
const fstatFd = promisify(fs.fstat);

/** How much of the queue goes to the kernel in one write. */
const CHUNK_BYTES = 64 * 1024;

interface Queued {
	line: string;
	bytes: number;
}

function positiveInteger(
	name: string,
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new SpectrumError(
			"E_SPECTRUM_INVALID_FILE_OPTIONS",
			`FileChannel ${name} must be a positive integer, got ${String(value)}`,
		);
	}
	return value;
}

export class FileChannel implements LogChannel {
	name = "file";
	readonly #filePath: string;
	/** Whether `#fd` was handed in rather than opened here. */
	readonly #fdGiven: boolean;
	readonly #maxSize: number;
	readonly #maxFiles: number;
	readonly #maxBuffer: number;
	#fd: number | null = null;
	/** Bytes in the live file, as far as this channel has written them. */
	#currentSize = 0;
	/** Lines accepted and not yet handed to the kernel. */
	#queue: Queued[] = [];
	/** Bytes of the queue plus the chunk being written. */
	#pendingBytes = 0;
	/** Lines refused since the last notice, because the queue was full. */
	#dropped = 0;
	/** The running pump, so there is only ever one and close() can wait for it. */
	#pump: Promise<void> | null = null;
	/** A rotation that failed lets the next chunk through rather than retrying forever. */
	#skipRotation = false;
	/**
	 * Terminal once `close()` has run: a line written after close is refused,
	 * and nothing reopens the file.
	 */
	#closed = false;
	#closing?: Promise<void>;
	readonly #ref = new WeakRef(this);

	constructor(config: FileChannelConfig) {
		const { path: filePath, fd } = config;
		if ((filePath === undefined) === (fd === undefined)) {
			throw new SpectrumError(
				"E_SPECTRUM_INVALID_FILE_OPTIONS",
				"FileChannel needs exactly one of `path` and `fd`",
			);
		}
		if (fd !== undefined && !(Number.isInteger(fd) && fd >= 0)) {
			throw new SpectrumError(
				"E_SPECTRUM_INVALID_FILE_OPTIONS",
				`FileChannel fd must be a non-negative integer, got ${String(fd)}`,
			);
		}
		this.#filePath = filePath ?? `fd ${String(fd)}`;
		this.#fdGiven = fd !== undefined;
		if (fd !== undefined) this.#fd = fd;
		// Checked here, not trusted: -1 rotated on every line and deleted the
		// log, and NaN (an unset env var through Number()) never rotated at all.
		this.#maxSize = positiveInteger(
			"maxSizeBytes",
			config.maxSizeBytes,
			10 * 1024 * 1024,
		);
		this.#maxFiles = positiveInteger("maxFiles", config.maxFiles, 5);
		this.#maxBuffer = positiveInteger(
			"maxBufferBytes",
			config.maxBufferBytes,
			16 * 1024 * 1024,
		);
	}

	write(entry: LogEntry): void {
		if (this.#closed) return;
		const line = `${stringifyRecord(entry, stringifyLimitsFor(entry))}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		if (this.#pendingBytes + bytes > this.#maxBuffer) {
			this.#dropped += 1;
			return;
		}
		this.#queue.push({ line, bytes });
		this.#pendingBytes += bytes;
		FileChannel.#track(this.#ref);
		this.#kick();
	}

	#kick(): void {
		if (this.#pump !== null) return;
		this.#pump = this.#drain().finally(() => {
			this.#pump = null;
			// A line queued between the loop's last check and here.
			if (this.#queue.length > 0 || this.#dropped > 0) this.#kick();
		});
	}

	async #drain(): Promise<void> {
		for (;;) {
			if (this.#queue.length === 0) {
				if (this.#dropped === 0) return;
				this.#enqueueDropNotice();
			}
			if (this.#fd === null && !(await this.#open())) {
				this.#discardQueue("could not be opened");
				return;
			}
			const chunk = this.#takeChunk();
			if (chunk === null) {
				await this.#rotate();
				continue;
			}
			await this.#writeChunk(chunk.text, chunk.bytes);
		}
	}

	/**
	 * Lines from the head of the queue that fit in the live file, up to
	 * {@link CHUNK_BYTES}; `null` when the head line needs a rotation first.
	 *
	 * An empty file takes its first line whatever its size: a line cannot be
	 * split, and one bigger than `maxSizeBytes` would otherwise rotate forever
	 * without ever being written.
	 */
	#takeChunk(): { text: string; bytes: number } | null {
		let text = "";
		let bytes = 0;
		while (this.#queue.length > 0) {
			const head = this.#queue[0];
			if (head === undefined) break;
			const size = this.#currentSize + bytes;
			const overflows =
				!this.#fdGiven && size > 0 && size + head.bytes > this.#maxSize;
			if (overflows && !this.#skipRotation) break;
			if (bytes > 0 && bytes + head.bytes > CHUNK_BYTES) break;
			this.#queue.shift();
			text += head.line;
			bytes += head.bytes;
			this.#skipRotation = false;
		}
		return bytes === 0 ? null : { text, bytes };
	}

	async #open(): Promise<boolean> {
		try {
			await fsp.mkdir(path.dirname(this.#filePath), { recursive: true });
			const fd = await openFd(this.#filePath, "a");
			try {
				this.#currentSize = (await fstatFd(fd)).size;
			} catch {
				this.#currentSize = 0;
			}
			this.#fd = fd;
			return true;
		} catch {
			return false;
		}
	}

	async #writeChunk(text: string, bytes: number): Promise<void> {
		const fd = this.#fd;
		if (fd === null) return;
		const buffer = Buffer.from(text, "utf8");
		try {
			let offset = 0;
			while (offset < buffer.length) {
				const { bytesWritten } = await writeFd(
					fd,
					buffer,
					offset,
					buffer.length - offset,
				);
				offset += bytesWritten;
			}
		} catch (err) {
			process.stderr.write(
				`[Spectrum] FileChannel write failed for '${this.#filePath}': ${err instanceof Error ? err.message : String(err)}\n`,
			);
		} finally {
			this.#currentSize += bytes;
			this.#pendingBytes -= bytes;
		}
	}

	/** Shift the generations up and leave the live path free for a new file. */
	async #rotate(): Promise<void> {
		const fd = this.#fd;
		this.#fd = null;
		if (fd !== null) await closeFd(fd).catch(() => undefined);
		try {
			if (this.#maxFiles === 1) {
				// No generation is kept: the live file starts over.
				await fsp.rm(this.#filePath, { force: true });
				return;
			}
			const oldest = `${this.#filePath}.${this.#maxFiles - 1}`;
			await fsp.rm(oldest, { force: true });
			// Oldest first: .1 → .2, .2 → .3…
			for (let i = this.#maxFiles - 2; i >= 1; i--) {
				await fsp
					.rename(`${this.#filePath}.${i}`, `${this.#filePath}.${i + 1}`)
					.catch(() => undefined); // that generation does not exist yet
			}
			await fsp.rename(this.#filePath, `${this.#filePath}.1`);
		} catch {
			process.stderr.write(
				`[Spectrum] FileChannel: rotation failed for '${this.#filePath}', writing on past maxSizeBytes\n`,
			);
			this.#skipRotation = true;
		}
	}

	#enqueueDropNotice(): void {
		const count = this.#dropped;
		this.#dropped = 0;
		const line = `${stringifyRecord({
			timestamp: new Date().toISOString(),
			level: "warn",
			module: "spectrum",
			message: `FileChannel dropped ${count} line(s): the destination did not keep up`,
			dropped: count,
		})}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		this.#queue.push({ line, bytes });
		this.#pendingBytes += bytes;
	}

	#discardQueue(reason: string): void {
		const lost = this.#queue.length;
		this.#queue = [];
		this.#pendingBytes = 0;
		this.#dropped = 0;
		process.stderr.write(
			`[Spectrum] FileChannel: '${this.#filePath}' ${reason}; ${lost} line(s) lost\n`,
		);
	}

	/**
	 * Write the queue now, synchronously — the process is exiting and there is
	 * no event loop left to run the pump.
	 *
	 * A chunk already handed to an asynchronous write is left to it, as pino's
	 * destination leaves it. The file is opened non-blocking when the pump had
	 * not opened it yet, so a destination nobody reads cannot hang the exit.
	 */
	#flushSync(): void {
		if (this.#dropped > 0) this.#enqueueDropNotice();
		if (this.#queue.length === 0) return;
		const text = this.#queue.map((queued) => queued.line).join("");
		this.#queue = [];
		this.#pendingBytes = 0;
		let fd = this.#fd;
		let opened = false;
		try {
			if (fd === null) {
				fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
				fd = fs.openSync(
					this.#filePath,
					fs.constants.O_WRONLY |
						fs.constants.O_APPEND |
						fs.constants.O_CREAT |
						(fs.constants.O_NONBLOCK ?? 0),
					0o666,
				);
				opened = true;
			}
			const buffer = Buffer.from(text, "utf8");
			let offset = 0;
			while (offset < buffer.length) {
				offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
			}
		} catch {
			process.stderr.write(
				`[Spectrum] FileChannel: lines lost writing '${this.#filePath}' at exit\n`,
			);
		} finally {
			if (opened && fd !== null) fs.closeSync(fd);
		}
	}

	/**
	 * Stop writing, for good, once everything accepted is on disk.
	 *
	 * Every caller awaits the SAME completion — the promise itself, not a
	 * wrapper around it, which is why this is not `async`. A second `close()`
	 * that resolved while the first was still flushing let a shutdown believe
	 * the last lines were on disk when they were still queued.
	 */
	close(): Promise<void> {
		this.#closing ??= this.#close();
		return this.#closing;
	}

	async #close(): Promise<void> {
		this.#closed = true;
		while (this.#pump !== null) await this.#pump;
		const fd = this.#fd;
		this.#fd = null;
		if (fd !== null && !this.#fdGiven) {
			await closeFd(fd).catch(() => undefined);
		}
		FileChannel.#untrack(this.#ref);
	}

	/** Channels with lines that the `exit` hook may have to write. Weak, as pino holds its destinations. */
	static readonly #tracked = new Set<WeakRef<FileChannel>>();

	static #track(ref: WeakRef<FileChannel>): void {
		if (FileChannel.#tracked.has(ref)) return;
		if (FileChannel.#tracked.size === 0)
			process.on("exit", FileChannel.#onExit);
		FileChannel.#tracked.add(ref);
	}

	static #untrack(ref: WeakRef<FileChannel>): void {
		if (!FileChannel.#tracked.delete(ref)) return;
		if (FileChannel.#tracked.size === 0) {
			process.removeListener("exit", FileChannel.#onExit);
		}
	}

	static readonly #onExit = (): void => {
		for (const ref of FileChannel.#tracked) {
			const channel = ref.deref();
			if (channel !== undefined) channel.#flushSync();
		}
	};
}
