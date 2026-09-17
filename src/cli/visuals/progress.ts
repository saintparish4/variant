/**
 * Progress reporting, ported from uv's indicatif-based reporters but
 * dependency-free: a root spinner plus a dynamic set of per-item bars,
 * repainted in place on stderr.
 *
 * The {@link Printer} decides whether bars may draw at all. When they are
 * hidden (piped output, CI, `--no-progress`, verbose mode), task and request
 * completions degrade gracefully to plain log lines instead of going silent.
 */

import {
	CLEAR_LINE,
	cursorUp,
	fitWidth,
	HIDE_CURSOR,
	SHOW_CURSOR,
	SYNC_END,
	SYNC_START,
} from "./ansi.js";
import type { Colors } from "./color.js";
import { getColors } from "./color.js";
import type { OutputStream, Printer } from "./printer.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 80;
const BAR_WIDTH = 30;
const FLAT_BAR_WIDTH = 20;

/** Convert a byte count into a human-readable `[value, unit]` pair. */
export function humanReadableBytes(bytes: number): [number, string] {
	const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
	if (bytes < 1) return [bytes, "B"];
	const exponent = Math.min(
		Math.floor(Math.log2(bytes) / 10),
		units.length - 1,
	);
	return [bytes / 1024 ** exponent, units[exponent] ?? "B"];
}

/** Format a byte count like `1.5 MiB`. */
export function formatBytes(bytes: number): string {
	const [value, unit] = humanReadableBytes(bytes);
	const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1);
	return `${rounded} ${unit}`;
}

export type Direction = "download" | "upload";

const DIRECTION_LABELS: Record<Direction, { active: string; done: string }> = {
	download: { active: "Downloading", done: "Downloaded" },
	upload: { active: "Uploading", done: "Uploaded" },
};

/** Repaints a block of lines in place using ANSI cursor movement. */
class BlockRenderer {
	private renderedLineCount = 0;

	constructor(private readonly stream: OutputStream) {}

	/**
	 * Emit one frame as a single write, wrapped in a synchronized update so
	 * the terminal paints it atomically. Permanent lines overwrite the top of
	 * the previous block and scroll away; the live block is redrawn below.
	 */
	frame(permanentLines: readonly string[], liveLines: readonly string[]): void {
		const columns = this.stream.columns ?? 80;
		let out = SYNC_START + cursorUp(this.renderedLineCount);
		for (const line of permanentLines) {
			out += `${CLEAR_LINE}${fitWidth(line, columns)}\n`;
		}
		for (const line of liveLines) {
			out += `${CLEAR_LINE}${fitWidth(line, columns)}\n`;
		}
		const leftover =
			this.renderedLineCount - permanentLines.length - liveLines.length;
		if (leftover > 0) {
			out += `${CLEAR_LINE}\n`.repeat(leftover) + cursorUp(leftover);
		}
		this.stream.write(out + SYNC_END);
		this.renderedLineCount = liveLines.length;
	}

	repaint(lines: readonly string[]): void {
		this.frame([], lines);
	}

	clear(): void {
		this.frame([], []);
	}
}

interface RequestState {
	direction: Direction;
	name: string;
	size: number | undefined;
	transferred: number;
}

export interface ProgressReporterOptions {
	/**
	 * Render only the root spinner, no per-item bars — for environments that
	 * cannot redraw multiple lines (e.g. Jupyter, detected via
	 * `JPY_SESSION_NAME`).
	 */
	singleMode?: boolean;
}

/** Whether the environment can only redraw a single line (Jupyter). */
export function detectSingleMode(): boolean {
	const session = process.env["JPY_SESSION_NAME"];
	return session !== undefined && session !== "";
}

function testProgressSuppressed(): boolean {
	const flag = process.env["VARIANT_TEST_NO_CLI_PROGRESS"];
	return flag !== undefined && flag !== "";
}

/**
 * Drives a root spinner plus a dynamic set of per-item progress bars: task
 * headers ("Building foo") pinned on top, transfer bars sorted by ascending
 * size below them, and the root spinner at the bottom.
 */
export class ProgressReporter {
	private readonly printer: Printer;
	private readonly renderer: BlockRenderer | undefined;
	private readonly singleMode: boolean;
	/** Pinned header lines (pre-rendered), in insertion order. */
	private readonly tasks = new Map<number, string>();
	private readonly requests = new Map<number, RequestState>();
	/** Permanent lines queued for the next frame (flushed in one write). */
	private readonly pendingLogs: string[] = [];
	private message: string;
	private nextId = 0;
	private maxNameLength = 0;
	private frame = 0;
	private timer: NodeJS.Timeout | undefined;
	private finished = false;

	private constructor(
		printer: Printer,
		message: string,
		options: ProgressReporterOptions,
	) {
		this.printer = printer;
		this.message = message;
		this.singleMode = options.singleMode ?? detectSingleMode();
		if (printer.progressEnabled) {
			this.renderer = new BlockRenderer(printer.progressStream);
			printer.progressStream.write(HIDE_CURSOR);
			this.timer = setInterval(() => this.tick(), TICK_MS);
			this.timer.unref();
			this.repaint();
		}
	}

	/** Build a reporter with a root spinner, e.g. for a resolve/prepare step. */
	static spinner(
		printer: Printer,
		message: string,
		options: ProgressReporterOptions = {},
	): ProgressReporter {
		return new ProgressReporter(printer, message, options);
	}

	/** Update the root spinner's message (e.g. the item currently in flight). */
	setMessage(message: string): void {
		this.message = message;
		this.repaint();
	}

	/** Finish and clear the whole block, restoring the cursor. */
	finish(): void {
		if (this.finished) return;
		if (this.timer !== undefined) clearInterval(this.timer);
		if (this.renderer !== undefined) {
			this.renderer.frame(this.pendingLogs.splice(0), []);
			this.printer.progressStream.write(SHOW_CURSOR);
		}
		this.finished = true;
	}

	/**
	 * Pin a fully custom, pre-rendered header line above the item bars.
	 * Returns an ID to pass to {@link finishTask} / {@link completeTask}.
	 */
	pinLine(line: string): number {
		const id = ++this.nextId;
		if (this.singleMode) return id;
		this.tasks.set(id, line);
		if (this.renderer === undefined) {
			this.logLine(line);
			return id;
		}
		this.repaint();
		return id;
	}

	/**
	 * Start a labeled header (e.g. "Building foo") pinned above the item bars.
	 * Returns an ID to pass to {@link finishTask}.
	 */
	startTask(verb: string, subject: string): number {
		const colors = getColors();
		return this.pinLine(`   ${colors.bold(colors.cyan(verb))} ${subject}`);
	}

	/** Complete a task started with {@link startTask}, leaving a done line. */
	finishTask(verb: string, subject: string, id: number): void {
		const colors = getColors();
		this.completeTask(
			id,
			`      ${colors.bold(colors.green(verb))} ${subject}`,
		);
	}

	/**
	 * Complete a task started with {@link startTask} with a fully custom line
	 * (e.g. a red failure line): removes the header and logs the line.
	 */
	completeTask(id: number, line: string): void {
		if (this.singleMode) return;
		this.tasks.delete(id);
		this.logLine(line);
	}

	/**
	 * Print a permanent line above the live block (indicatif's `println`) — or
	 * as a plain stderr line when bars are hidden.
	 */
	log(line: string): void {
		this.logLine(line);
	}

	/**
	 * Start tracking a download/upload with an optional known size. Returns an
	 * ID to pass to {@link requestProgress} / {@link requestComplete}.
	 */
	requestStart(direction: Direction, name: string, size?: number): number {
		const id = ++this.nextId;
		if (this.singleMode) return id;
		this.requests.set(id, { direction, name, size, transferred: 0 });
		this.maxNameLength = Math.max(this.maxNameLength, name.length);
		this.repaint();
		return id;
	}

	/** Record `bytes` more transferred for a request. */
	requestProgress(id: number, bytes: number): void {
		const request = this.requests.get(id);
		if (request === undefined) return;
		request.transferred += bytes;
		this.repaint();
	}

	/** Complete and clear a request bar. */
	requestComplete(id: number): void {
		const request = this.requests.get(id);
		if (request === undefined) return;
		this.requests.delete(id);
		if (this.renderer === undefined) {
			const colors = getColors();
			const label = DIRECTION_LABELS[request.direction].done;
			const detail =
				request.size !== undefined ? ` (${formatBytes(request.size)})` : "";
			this.logLine(
				`${colors.bold(colors.green(label))} ${request.name}${colors.dim(detail)}`,
			);
			return;
		}
		this.repaint();
	}

	/**
	 * Print a permanent line above the live block — or as a plain stderr line
	 * when bars are hidden, so output degrades gracefully in pipes and CI.
	 * Visible-mode lines are queued and flushed inside the next frame's single
	 * write, so the terminal never paints an intermediate state.
	 */
	private logLine(line: string): void {
		if (this.renderer === undefined) {
			if (!testProgressSuppressed()) this.printer.stderr(`${line}\n`);
			return;
		}
		this.pendingLogs.push(line);
		this.repaint();
	}

	private tick(): void {
		this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
		this.repaint();
	}

	private repaint(): void {
		if (this.renderer === undefined || this.finished) return;
		this.renderer.frame(this.pendingLogs.splice(0), this.composeLines());
	}

	private composeLines(): string[] {
		const colors = getColors();
		const lines: string[] = [...this.tasks.values()];
		const requests = [...this.requests.values()].sort(
			(a, b) => (a.size ?? 0) - (b.size ?? 0),
		);
		for (const request of requests) {
			lines.push(this.composeRequestLine(request, colors));
		}
		const spinnerFrame = SPINNER_FRAMES[this.frame] ?? "⠋";
		lines.push(`${spinnerFrame} ${colors.dim(this.message)}`);
		return lines;
	}

	private composeRequestLine(request: RequestState, colors: Colors): string {
		const name = colors.dim(request.name.padEnd(this.maxNameLength));
		if (request.size === undefined) {
			return `${name} ${colors.dim("....")}`;
		}
		const ratio =
			request.size === 0 ? 1 : Math.min(request.transferred / request.size, 1);
		const filled = Math.round(ratio * BAR_WIDTH);
		const bar =
			colors.green("█".repeat(filled)) +
			colors.dim("░".repeat(BAR_WIDTH - filled));
		const transferred = formatBytes(request.transferred).padStart(9);
		return `${name} ${bar} ${transferred}/${formatBytes(request.size)}`;
	}
}

/**
 * A flat single bar for a known-length, single-phase operation (e.g. running
 * N tasks) — no multi-bar coordination needed.
 */
export class FlatProgressReporter {
	private readonly printer: Printer;
	private readonly renderer: BlockRenderer | undefined;
	private readonly length: number;
	private position = 0;
	private message: string;
	private finished = false;

	constructor(printer: Printer, message: string, length: number) {
		this.printer = printer;
		this.message = message;
		this.length = length;
		if (printer.progressEnabled) {
			this.renderer = new BlockRenderer(printer.progressStream);
			printer.progressStream.write(HIDE_CURSOR);
			this.repaint();
		}
	}

	/** Advance the bar by `delta` steps and update the trailing message. */
	inc(delta: number, message: string): void {
		this.position = Math.min(this.position + delta, this.length);
		this.message = message;
		this.repaint();
	}

	/** Finish and clear the bar, restoring the cursor. */
	finish(): void {
		if (this.finished) return;
		if (this.renderer !== undefined) {
			this.renderer.clear();
			this.printer.progressStream.write(SHOW_CURSOR);
		}
		this.finished = true;
	}

	private repaint(): void {
		if (this.renderer === undefined || this.finished) return;
		const colors = getColors();
		const ratio = this.length === 0 ? 1 : this.position / this.length;
		const filled = Math.round(ratio * FLAT_BAR_WIDTH);
		const bar =
			colors.green("█".repeat(filled)) +
			colors.dim("░".repeat(FLAT_BAR_WIDTH - filled));
		this.renderer.repaint([
			`${bar} [${this.position}/${this.length}] ${colors.dim(this.message)}`,
		]);
	}
}
