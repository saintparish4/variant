/**
 * Output gating for the CLI, ported from uv's `Printer`.
 *
 * Built once at startup from `-q`/`-v`/`--no-progress`, the printer is the
 * single source of truth for two questions: "is stdout/stderr enabled?" and
 * "may animated progress draw?". Callers write unconditionally and the
 * printer silently no-ops when disabled — no `if` branches scattered through
 * business logic.
 */

/** A writable sink; `process.stdout`/`process.stderr` satisfy this shape. */
export interface OutputStream {
	write(text: string): void;
	isTTY?: boolean | undefined;
	columns?: number | undefined;
}

export type PrinterMode =
	/** Suppresses all output; errors still reach stderr through the CLI top level. */
	| "silent"
	/** Keeps results on stdout; suppresses diagnostics and progress on stderr. */
	| "quiet"
	/** Prints to standard streams. */
	| "default"
	/** Prints everything, including debug messages; hides progress bars. */
	| "verbose"
	/** Prints to standard streams, excluding progress output. */
	| "no-progress";

export interface PrinterFlags {
	/** Count of `-q` occurrences (1 = quiet, 2+ = silent). */
	quiet?: number;
	/** Count of `-v` occurrences. */
	verbose?: number;
	noProgress?: boolean;
}

export interface PrinterStreams {
	stdout?: OutputStream;
	stderr?: OutputStream;
}

export class Printer {
	readonly mode: PrinterMode;
	private readonly out: OutputStream;
	private readonly err: OutputStream;

	constructor(mode: PrinterMode, streams: PrinterStreams = {}) {
		this.mode = mode;
		this.out = streams.stdout ?? process.stdout;
		this.err = streams.stderr ?? process.stderr;
	}

	static fromFlags(
		flags: PrinterFlags = {},
		streams?: PrinterStreams,
	): Printer {
		const quiet = flags.quiet ?? 0;
		const verbose = flags.verbose ?? 0;
		if (quiet === 1) return new Printer("quiet", streams);
		if (quiet > 1) return new Printer("silent", streams);
		if (verbose > 0) return new Printer("verbose", streams);
		if (flags.noProgress) return new Printer("no-progress", streams);
		return new Printer("default", streams);
	}

	/**
	 * As in uv, `-q` quiets the commentary, not the answer: a script that asks
	 * for `--json` with `-q` still gets its JSON. Only `-qq` silences stdout.
	 */
	get stdoutEnabled(): boolean {
		return this.mode !== "silent";
	}

	get stderrEnabled(): boolean {
		return this.mode !== "silent" && this.mode !== "quiet";
	}

	/**
	 * Whether animated progress may draw: only in default mode on a TTY.
	 * Verbose hides bars so they don't interleave with debug logs, and
	 * `VARIANT_TEST_NO_CLI_PROGRESS` suppresses them because concurrent bar
	 * output is non-deterministic and breaks snapshot tests.
	 */
	get progressEnabled(): boolean {
		if (this.mode !== "default" || this.err.isTTY !== true) return false;
		const testFlag = process.env["VARIANT_TEST_NO_CLI_PROGRESS"];
		return testFlag === undefined || testFlag === "";
	}

	/** The raw stderr sink, for renderers that manage their own ANSI drawing. */
	get progressStream(): OutputStream {
		return this.err;
	}

	stdout(text: string): void {
		if (this.stdoutEnabled) this.out.write(text);
	}

	stderr(text: string): void {
		if (this.stderrEnabled) this.err.write(text);
	}

	/** Write a debug line, shown only in verbose mode. */
	debug(text: string): void {
		if (this.mode === "verbose") this.err.write(text);
	}
}

let globalPrinter = new Printer("default");

/** Install the process-wide printer, once at startup after flag parsing. */
export function setGlobalPrinter(printer: Printer): void {
	globalPrinter = printer;
}

/** The process-wide printer (a permissive default before flags are parsed). */
export function getPrinter(): Printer {
	return globalPrinter;
}
