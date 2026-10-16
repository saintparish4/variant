import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	hostEnvironment,
	parseFailingTests,
	toBaselineTest,
	toPlannedMutant,
	toTestedMutant,
} from "../stryker.js";

const cwd = path.resolve("/work/app");

describe("toPlannedMutant", () => {
	// Measured on Stryker 10: the plan event says line 1, column 8 for the
	// `total` of `\treturn total >= 100;` on line 2; the results say 2 and 9.
	it("turns the plan's 0-based positions into 1-based ones", () => {
		const mutant = toPlannedMutant(cwd, {
			id: "2",
			fileName: path.join(cwd, "src", "discount.ts"),
			mutatorName: "EqualityOperator",
			replacement: "total > 100",
			location: {
				start: { line: 1, column: 8 },
				end: { line: 1, column: 20 },
			},
			coveredBy: ["src/discount.test.ts#accepts 150"],
			static: false,
		});

		expect(mutant).toEqual({
			id: "2",
			file: "src/discount.ts",
			mutator: "EqualityOperator",
			replacement: "total > 100",
			start: { line: 2, column: 9 },
			end: { line: 2, column: 21 },
			covered: true,
			static: false,
		});
	});

	it("reads an empty coveredBy as code no test executed", () => {
		const mutant = toPlannedMutant(cwd, {
			id: "4",
			fileName: path.join(cwd, "src", "a.ts"),
			mutatorName: "ConditionalExpression",
			replacement: "true",
			location: { start: { line: 0, column: 0 }, end: { line: 0, column: 4 } },
			coveredBy: [],
		});

		expect(mutant.covered).toBe(false);
		expect(mutant.static).toBe(false);
	});
});

describe("toTestedMutant", () => {
	it("keeps Stryker's status and the test that killed the mutant", () => {
		expect(
			toTestedMutant({
				id: "1",
				status: "Killed",
				killedBy: ["t1"],
				testsCompleted: 2,
				statusReason: "expected false to be true",
			}),
		).toEqual({
			id: "1",
			status: "Killed",
			killedBy: ["t1"],
			testsCompleted: 2,
			statusReason: "expected false to be true",
		});
	});

	// A status this version does not know is not a verdict either way.
	it("reads an unknown status as an error, never as detected", () => {
		expect(toTestedMutant({ id: "1", status: "Mystery" }).status).toBe(
			"RuntimeError",
		);
	});
});

describe("toBaselineTest", () => {
	it("makes the test file relative to the project", () => {
		expect(
			toBaselineTest(cwd, {
				id: "src/a.test.ts#a works",
				name: "a works",
				fileName: path.join(cwd, "src", "a.test.ts"),
			}).file,
		).toBe("src/a.test.ts");
	});
});

describe("parseFailingTests", () => {
	// The format Stryker 10 logs with `logLevel: "error"`, as captured.
	it("reads the failing baseline tests Stryker logs", () => {
		const output = [
			"23:33:41 (47397) ERROR DryRunExecutor One or more tests failed in the initial test run:",
			"\tqualifies rejects 50",
			"\t\texpected false to be true // Object.is equality",
			"\tqualifies accepts 150",
			"\t\texpected true to be false",
			"23:33:41 (47397) ERROR Stryker There were failed tests in the initial test run.",
		].join("\n");

		expect(parseFailingTests(output)).toEqual([
			{
				name: "qualifies rejects 50",
				message: "expected false to be true // Object.is equality",
			},
			{ name: "qualifies accepts 150", message: "expected true to be false" },
		]);
	});

	it("finds nothing in output that does not list failing tests", () => {
		expect(parseFailingTests("ERROR something else entirely")).toEqual([]);
	});
});

describe("hostEnvironment", () => {
	it("keeps git and CI files that point outside the sandbox from reaching it", () => {
		const env = hostEnvironment(
			{
				PATH: "/bin",
				CI: "true",
				GIT_INDEX_FILE: "/repo/.git/index",
				GIT_DIR: "/repo/.git",
				GITHUB_STEP_SUMMARY: "/tmp/summary",
				GITHUB_SHA: "abc",
				VITEST_POOL_ID: "1",
				VARIANT_SHADOW: "1",
			},
			"/repo/.variant/check-tmp",
		);

		expect(env).toEqual({
			PATH: "/bin",
			CI: "true",
			GITHUB_SHA: "abc",
			GIT_CEILING_DIRECTORIES: "/repo/.variant/check-tmp",
			VARIANT_SHADOW: "0",
		});
	});
});
