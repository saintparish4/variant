import { beforeEach, describe, expect, it } from "vitest";
import { captureOutput } from "../../../__tests__/helpers/cli-harness.js";
import { computeInsights } from "../../../core/insight/analyzer.js";
import { writeGlobalColorChoice } from "../../visuals/color.js";
import { renderEnv, renderInsights } from "../insight.js";

beforeEach(() => {
	// Colors would otherwise depend on FORCE_COLOR in the runner's environment.
	writeGlobalColorChoice("never");
});

describe("renderInsights with no run results", () => {
	it("says there is nothing to report when the cache is empty too", () => {
		const capture = captureOutput();

		renderInsights(computeInsights([], { tasks: {} }), capture.printer);

		expect(capture.stdout()).toContain("No cached task data yet");
	});

	it("shows cached history with durations for previously run tasks", () => {
		const capture = captureOutput();

		renderInsights(
			computeInsights([], {
				tasks: {
					typecheck: { lastRun: 1, lastDurationMs: 10 },
					build: { lastRun: 2, lastDurationMs: 99 },
				},
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Cached task history");
		expect(capture.stdout()).toContain("typecheck");
		expect(capture.stdout()).toContain("10ms");
		expect(capture.stdout()).toContain("99ms");
	});

	it("reports an unknown duration for an entry with no recorded timing", () => {
		const capture = captureOutput();

		renderInsights(
			computeInsights([], { tasks: { build: { lastRun: 1 } } }),
			capture.printer,
		);

		expect(capture.stdout()).toContain("unknown");
	});
});

describe("renderInsights with run results", () => {
	it("shows MISS and the real duration for a cache miss", () => {
		const capture = captureOutput();

		renderInsights(
			computeInsights([{ task: "build", durationMs: 1234, cacheHit: false }], {
				tasks: {},
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("1234ms");
		expect(capture.stdout()).toContain("MISS");
	});

	it("shows HIT and a dash instead of a zero duration for a cache hit", () => {
		const capture = captureOutput();

		renderInsights(
			computeInsights([{ task: "lint", durationMs: 0, cacheHit: true }], {
				tasks: {},
			}),
			capture.printer,
		);

		expect(capture.stdout()).toMatch(/lint\s+-\s+HIT/);
	});

	it("shows SKIP for a task the filter excluded", () => {
		const capture = captureOutput();

		renderInsights(
			computeInsights(
				[{ task: "test", durationMs: 0, cacheHit: false, skipped: true }],
				{ tasks: {} },
			),
			capture.printer,
		);

		expect(capture.stdout()).toMatch(/test\s+-\s+SKIP/);
	});

	it("footers the total duration and hit rate", () => {
		const capture = captureOutput();

		renderInsights(
			computeInsights(
				[
					{ task: "lint", durationMs: 0, cacheHit: true },
					{ task: "build", durationMs: 0, cacheHit: true },
				],
				{ tasks: {} },
			),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Total: 0ms");
		expect(capture.stdout()).toContain("Cache hit rate: 100%");
	});

	it("reports a 0% hit rate when everything missed", () => {
		const capture = captureOutput();

		renderInsights(
			computeInsights([{ task: "build", durationMs: 500, cacheHit: false }], {
				tasks: {},
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Cache hit rate: 0%");
	});

	it("pads the task column to the longest name so statuses line up", () => {
		const capture = captureOutput();

		renderInsights(
			computeInsights(
				[
					{ task: "a-very-long-task-name", durationMs: 100, cacheHit: false },
					{ task: "x", durationMs: 200, cacheHit: false },
				],
				{ tasks: {} },
			),
			capture.printer,
		);

		const rows = capture
			.stdout()
			.split("\n")
			.filter((line) => line.includes("MISS"));
		expect(rows).toHaveLength(2);
		expect(rows[0]?.indexOf("MISS")).toBe(rows[1]?.indexOf("MISS"));
	});

	it("writes nothing at all when the printer is silent", () => {
		const capture = captureOutput("silent");

		renderInsights(
			computeInsights([{ task: "build", durationMs: 1, cacheHit: false }], {
				tasks: {},
			}),
			capture.printer,
		);

		expect(capture.stdout()).toBe("");
	});
});

describe("renderEnv", () => {
	it("prints the package manager, runtime, and framework", () => {
		const capture = captureOutput();

		renderEnv(
			"pnpm",
			{ primary: "node", fallback: "node" },
			"next",
			capture.printer,
		);

		expect(capture.stdout()).toContain("pnpm");
		expect(capture.stdout()).toContain("next");
	});

	it("says 'none detected' when no framework was found", () => {
		const capture = captureOutput();

		renderEnv(
			"npm",
			{ primary: "node", fallback: "node" },
			null,
			capture.printer,
		);

		expect(capture.stdout()).toContain("none detected");
	});

	it("names the fallback runtime alongside the primary", () => {
		const capture = captureOutput();

		renderEnv(
			"yarn",
			{ primary: "bun", fallback: "node" },
			null,
			capture.printer,
		);

		expect(capture.stdout()).toContain("bun");
		expect(capture.stdout()).toContain("fallback: node");
	});
});
