import path from "node:path";
import { describe, expect, it } from "vitest";
import { ImpactReportError } from "../../errors.js";
import type { ImpactPrediction } from "../../history/impact-log.js";
import { parseFailedTests, reconcile } from "../verify.js";

const CWD = path.resolve("/repo");

function prediction(
	overrides: Partial<ImpactPrediction> = {},
): ImpactPrediction {
	return {
		at: "2026-01-01T00:00:00.000Z",
		baseRef: "HEAD~1",
		headSha: "a".repeat(40),
		changedFiles: ["src/math.ts"],
		affectedFiles: 1,
		affectedPackages: [],
		affectedTests: ["src/__tests__/math.test.ts"],
		totalTests: 2,
		selectAll: false,
		verdict: "build-recommended",
		confidence: 1,
		notes: [],
		...overrides,
	};
}

const report = (results: Array<{ name: string; status: string }>): string =>
	JSON.stringify({ testResults: results });

describe("parseFailedTests", () => {
	it("reports only the failing files", () => {
		expect(
			parseFailedTests(
				CWD,
				report([
					{ name: path.join(CWD, "a.test.ts"), status: "failed" },
					{ name: path.join(CWD, "b.test.ts"), status: "passed" },
				]),
			),
		).toEqual(["a.test.ts"]);
	});

	it("relativizes absolute runner paths against the workspace", () => {
		expect(
			parseFailedTests(
				CWD,
				report([
					{ name: path.join(CWD, "src", "x.test.ts"), status: "failed" },
				]),
			),
		).toEqual(["src/x.test.ts"]);
	});

	it("relativizes a runner path reached through a symlink to the workspace", () => {
		// macOS: getcwd() answers /private/var/..., os.tmpdir() answers /var/...
		const realCwd = path.resolve("/private/repo");
		const realpath = (target: string): string =>
			target.startsWith(CWD) ? realCwd + target.slice(CWD.length) : target;
		expect(
			parseFailedTests(
				realCwd,
				report([
					{ name: path.join(CWD, "src", "x.test.ts"), status: "failed" },
				]),
				realpath,
			),
		).toEqual(["src/x.test.ts"]);
	});

	it("accepts a path the runner already reported as relative", () => {
		expect(
			parseFailedTests(
				CWD,
				report([{ name: "src/x.test.ts", status: "failed" }]),
			),
		).toEqual(["src/x.test.ts"]);
	});

	it("deduplicates a file reported failing more than once", () => {
		expect(
			parseFailedTests(
				CWD,
				report([
					{ name: "a.test.ts", status: "failed" },
					{ name: "a.test.ts", status: "failed" },
				]),
			),
		).toEqual(["a.test.ts"]);
	});

	it("skips entries that do not match the expected shape", () => {
		const raw = JSON.stringify({
			testResults: [
				null,
				{ status: "failed" },
				{ name: 42, status: "failed" },
				{ name: "real.test.ts", status: "failed" },
			],
		});
		expect(parseFailedTests(CWD, raw)).toEqual(["real.test.ts"]);
	});

	it("returns nothing for a run where everything passed", () => {
		expect(
			parseFailedTests(CWD, report([{ name: "a.test.ts", status: "passed" }])),
		).toEqual([]);
	});

	it("rejects a report that is not JSON", () => {
		expect(() => parseFailedTests(CWD, "}{")).toThrow(ImpactReportError);
	});

	it("rejects a report with no testResults array", () => {
		expect(() => parseFailedTests(CWD, JSON.stringify({ ok: true }))).toThrow(
			ImpactReportError,
		);
	});
});

describe("reconcile", () => {
	it("counts a failure inside the predicted set as caught", () => {
		const result = reconcile(prediction(), ["src/__tests__/math.test.ts"]);

		expect(result.caught).toEqual(["src/__tests__/math.test.ts"]);
		expect(result.falseSkips).toEqual([]);
		expect(result.falseSkipRate).toBe(0);
	});

	it("counts a failure outside the predicted set as a false skip", () => {
		const result = reconcile(prediction(), ["src/__tests__/format.test.ts"]);

		expect(result.caught).toEqual([]);
		expect(result.falseSkips).toEqual(["src/__tests__/format.test.ts"]);
		expect(result.falseSkipRate).toBe(1);
	});

	it("splits a mixed run and rates it by failures, not by suite size", () => {
		const result = reconcile(prediction(), [
			"src/__tests__/math.test.ts",
			"src/__tests__/format.test.ts",
		]);

		expect(result.caught).toEqual(["src/__tests__/math.test.ts"]);
		expect(result.falseSkips).toEqual(["src/__tests__/format.test.ts"]);
		expect(result.falseSkipRate).toBe(0.5);
	});

	it("cannot produce a false skip when the prediction selected everything", () => {
		const result = reconcile(
			prediction({ selectAll: true, affectedTests: [] }),
			["src/__tests__/format.test.ts"],
		);

		expect(result.falseSkips).toEqual([]);
		expect(result.caught).toEqual(["src/__tests__/format.test.ts"]);
	});

	it("rates a run with no failures as zero, which is evidence of nothing", () => {
		const result = reconcile(prediction(), []);

		expect(result.falseSkipRate).toBe(0);
		expect(result.caught).toEqual([]);
		expect(result.falseSkips).toEqual([]);
	});
});
