import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeGlobalColorChoice } from "../color.js";
import type { OutputStream } from "../printer.js";
import { Printer } from "../printer.js";
import {
	detectSingleMode,
	FlatProgressReporter,
	formatBytes,
	humanReadableBytes,
	ProgressReporter,
} from "../progress.js";

const ESC = String.fromCharCode(27);

function fakeStream(isTTY: boolean): {
	chunks: string[];
	stream: OutputStream;
} {
	const chunks: string[] = [];
	return {
		chunks,
		stream: {
			isTTY,
			columns: 120,
			write: (text: string) => {
				chunks.push(text);
			},
		},
	};
}

function ttyPrinter(): { chunks: string[]; printer: Printer } {
	const { chunks, stream } = fakeStream(true);
	return { chunks, printer: new Printer("default", { stderr: stream }) };
}

function pipePrinter(): { chunks: string[]; printer: Printer } {
	const { chunks, stream } = fakeStream(false);
	return { chunks, printer: new Printer("default", { stderr: stream }) };
}

beforeEach(() => {
	writeGlobalColorChoice("never");
	vi.stubEnv("VARIANT_TEST_NO_CLI_PROGRESS", "");
});

afterEach(() => {
	writeGlobalColorChoice("auto");
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("humanReadableBytes", () => {
	it("handles zero", () => {
		expect(humanReadableBytes(0)).toEqual([0, "B"]);
	});

	it("converts across unit boundaries", () => {
		expect(humanReadableBytes(1024)).toEqual([1, "KiB"]);
		expect(humanReadableBytes(1024 ** 2)).toEqual([1, "MiB"]);
	});

	it("formats with one decimal below 100", () => {
		expect(formatBytes(1536)).toBe("1.5 KiB");
		expect(formatBytes(512)).toBe("512 B");
	});
});

describe("detectSingleMode", () => {
	it("detects Jupyter via JPY_SESSION_NAME", () => {
		vi.stubEnv("JPY_SESSION_NAME", "kernel-1");
		expect(detectSingleMode()).toBe(true);
	});

	it("is false otherwise", () => {
		vi.stubEnv("JPY_SESSION_NAME", "");
		expect(detectSingleMode()).toBe(false);
	});
});

describe("ProgressReporter (visible on a TTY)", () => {
	it("draws a ticking root spinner and clears on finish", () => {
		vi.useFakeTimers();
		const { chunks, printer } = ttyPrinter();
		const reporter = ProgressReporter.spinner(printer, "Resolving...", {
			singleMode: false,
		});
		expect(chunks.join("")).toContain("⠋ Resolving...");
		vi.advanceTimersByTime(100);
		expect(chunks.join("")).toContain("⠙ Resolving...");
		reporter.finish();
		expect(chunks.join("")).toContain(`${ESC}[?25h`);
	});

	it("pins task headers above the spinner and logs done lines", () => {
		const { chunks, printer } = ttyPrinter();
		const reporter = ProgressReporter.spinner(printer, "Working...", {
			singleMode: false,
		});
		const id = reporter.startTask("Building", "pkg-a");
		expect(chunks.join("")).toContain("   Building pkg-a");
		reporter.finishTask("Built", "pkg-a", id);
		expect(chunks.join("")).toContain("      Built pkg-a\n");
		reporter.finish();
	});

	it("renders request bars with transferred/total bytes", () => {
		const { chunks, printer } = ttyPrinter();
		const reporter = ProgressReporter.spinner(printer, "Working...", {
			singleMode: false,
		});
		const id = reporter.requestStart("download", "pkg-a", 2048);
		reporter.requestProgress(id, 1024);
		const output = chunks.join("");
		expect(output).toContain("pkg-a");
		expect(output).toContain("1.0 KiB/2.0 KiB");
		reporter.requestComplete(id);
		reporter.finish();
	});

	it("renders unknown-size requests as dotted lines", () => {
		const { chunks, printer } = ttyPrinter();
		const reporter = ProgressReporter.spinner(printer, "Working...", {
			singleMode: false,
		});
		reporter.requestStart("download", "pkg-b");
		expect(chunks.join("")).toContain("pkg-b ....");
		reporter.finish();
	});

	it("logs permanent lines above the live block", () => {
		const { chunks, printer } = ttyPrinter();
		const reporter = ProgressReporter.spinner(printer, "Working...", {
			singleMode: false,
		});
		reporter.log("summary line");
		expect(chunks.join("")).toContain("summary line\n");
		reporter.finish();
	});

	it("completes a task with a custom line", () => {
		const { chunks, printer } = ttyPrinter();
		const reporter = ProgressReporter.spinner(printer, "Working...", {
			singleMode: false,
		});
		const id = reporter.startTask("→", "pkg-a");
		reporter.completeTask(id, "  ✗ pkg-a");
		expect(chunks.join("")).toContain("  ✗ pkg-a\n");
		reporter.finish();
	});
});

describe("ProgressReporter (hidden, piped output)", () => {
	it("degrades task and request completion to plain log lines", () => {
		const { chunks, printer } = pipePrinter();
		const reporter = ProgressReporter.spinner(printer, "Working...", {
			singleMode: false,
		});
		const taskId = reporter.startTask("Building", "pkg-a");
		reporter.finishTask("Built", "pkg-a", taskId);
		const requestId = reporter.requestStart("download", "pkg-b", 1024);
		reporter.requestComplete(requestId);
		reporter.finish();

		const output = chunks.join("");
		expect(output).toContain("Building pkg-a");
		expect(output).toContain("Built pkg-a");
		expect(output).toContain("Downloaded pkg-b (1.0 KiB)");
		expect(output).not.toContain(ESC);
	});

	it("stays fully silent when VARIANT_TEST_NO_CLI_PROGRESS is set", () => {
		vi.stubEnv("VARIANT_TEST_NO_CLI_PROGRESS", "1");
		const { chunks, printer } = pipePrinter();
		const reporter = ProgressReporter.spinner(printer, "Working...", {
			singleMode: false,
		});
		const id = reporter.startTask("Building", "pkg-a");
		reporter.finishTask("Built", "pkg-a", id);
		reporter.finish();
		expect(chunks).toEqual([]);
	});

	it("suppresses per-item output in single mode", () => {
		const { chunks, printer } = pipePrinter();
		const reporter = ProgressReporter.spinner(printer, "Working...", {
			singleMode: true,
		});
		const id = reporter.startTask("Building", "pkg-a");
		reporter.finishTask("Built", "pkg-a", id);
		reporter.finish();
		expect(chunks).toEqual([]);
	});
});

describe("FlatProgressReporter", () => {
	it("renders position over length and clears on finish", () => {
		const { chunks, printer } = ttyPrinter();
		const reporter = new FlatProgressReporter(printer, "installing", 4);
		reporter.inc(1, "pkg-a");
		reporter.inc(2, "pkg-b");
		const output = chunks.join("");
		expect(output).toContain("[0/4] installing");
		expect(output).toContain("[1/4] pkg-a");
		expect(output).toContain("[3/4] pkg-b");
		reporter.finish();
		expect(chunks.join("")).toContain(`${ESC}[?25h`);
	});

	it("draws nothing when progress is disabled", () => {
		const { chunks, printer } = pipePrinter();
		const reporter = new FlatProgressReporter(printer, "installing", 4);
		reporter.inc(1, "pkg-a");
		reporter.finish();
		expect(chunks).toEqual([]);
	});
});
