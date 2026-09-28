import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutputStream } from "../printer.js";
import { getPrinter, Printer, setGlobalPrinter } from "../printer.js";

function fakeStream(isTTY = false): { chunks: string[]; stream: OutputStream } {
	const chunks: string[] = [];
	return {
		chunks,
		stream: {
			isTTY,
			columns: 80,
			write: (text: string) => {
				chunks.push(text);
			},
		},
	};
}

describe("Printer.fromFlags", () => {
	it("maps flag counts to modes like uv", () => {
		expect(Printer.fromFlags({}).mode).toBe("default");
		expect(Printer.fromFlags({ quiet: 1 }).mode).toBe("quiet");
		expect(Printer.fromFlags({ quiet: 2 }).mode).toBe("silent");
		expect(Printer.fromFlags({ verbose: 1 }).mode).toBe("verbose");
		expect(Printer.fromFlags({ noProgress: true }).mode).toBe("no-progress");
	});

	it("lets quiet win over verbose", () => {
		expect(Printer.fromFlags({ quiet: 1, verbose: 2 }).mode).toBe("quiet");
	});
});

describe("output gating", () => {
	it("writes both streams in default mode", () => {
		const out = fakeStream();
		const err = fakeStream();
		const printer = new Printer("default", {
			stdout: out.stream,
			stderr: err.stream,
		});
		printer.stdout("a");
		printer.stderr("b");
		expect(out.chunks).toEqual(["a"]);
		expect(err.chunks).toEqual(["b"]);
	});

	// -q once dropped stdout too, so `variant -q impact --json` printed nothing:
	// the same as -qq, and useless in a script.
	it("keeps results on stdout but drops diagnostics in quiet mode", () => {
		const out = fakeStream();
		const err = fakeStream();
		const printer = new Printer("quiet", {
			stdout: out.stream,
			stderr: err.stream,
		});
		printer.stdout("a");
		printer.stderr("b");
		expect(out.chunks).toEqual(["a"]);
		expect(err.chunks).toEqual([]);
	});

	it("suppresses both streams in silent mode", () => {
		const out = fakeStream();
		const err = fakeStream();
		const printer = new Printer("silent", {
			stdout: out.stream,
			stderr: err.stream,
		});
		printer.stdout("a");
		printer.stderr("b");
		expect(out.chunks).toEqual([]);
		expect(err.chunks).toEqual([]);
	});

	it("writes debug lines only in verbose mode", () => {
		const verbose = fakeStream();
		new Printer("verbose", { stderr: verbose.stream }).debug("d");
		expect(verbose.chunks).toEqual(["d"]);

		const normal = fakeStream();
		new Printer("default", { stderr: normal.stream }).debug("d");
		expect(normal.chunks).toEqual([]);
	});
});

describe("progressEnabled", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("is true only in default mode on a TTY", () => {
		vi.stubEnv("VARIANT_TEST_NO_CLI_PROGRESS", "");
		const tty = fakeStream(true).stream;
		expect(new Printer("default", { stderr: tty }).progressEnabled).toBe(true);
		expect(new Printer("verbose", { stderr: tty }).progressEnabled).toBe(false);
		expect(new Printer("no-progress", { stderr: tty }).progressEnabled).toBe(
			false,
		);
		expect(new Printer("quiet", { stderr: tty }).progressEnabled).toBe(false);
		const pipe = fakeStream(false).stream;
		expect(new Printer("default", { stderr: pipe }).progressEnabled).toBe(
			false,
		);
	});

	it("is suppressed by VARIANT_TEST_NO_CLI_PROGRESS", () => {
		vi.stubEnv("VARIANT_TEST_NO_CLI_PROGRESS", "1");
		const tty = fakeStream(true).stream;
		expect(new Printer("default", { stderr: tty }).progressEnabled).toBe(false);
	});
});

describe("global printer", () => {
	afterEach(() => {
		setGlobalPrinter(new Printer("default"));
	});

	it("returns the installed printer", () => {
		const printer = new Printer("quiet");
		setGlobalPrinter(printer);
		expect(getPrinter()).toBe(printer);
	});
});
