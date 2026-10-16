import path from "node:path";
import type { DryRunResult } from "@stryker-mutator/api/test-runner";
import { DryRunStatus, TestStatus } from "@stryker-mutator/api/test-runner";
import { describe, expect, it } from "vitest";
import type {
	JestConfigModule,
	JestResults,
	WithJestConfig,
} from "../stryker-jest.js";
import { withLoadFailures, withResolvedEnvironment } from "../stryker-jest.js";

function jestConfig(
	normalize: JestConfigModule["normalize"],
): () => JestConfigModule {
	return () => ({ normalize });
}

describe("the test environment Stryker is given", () => {
	// pnpm: `jest-environment-node` is Jest's dependency, not the project's,
	// and Stryker looks for it in the project.
	it("is the path Jest itself resolves", async () => {
		const runner: WithJestConfig = { jestConfig: { rootDir: "/repo" } };

		await withResolvedEnvironment(
			runner,
			"/repo",
			jestConfig(async (options) => ({
				options: {
					testEnvironment: `/store/jest-environment-node/${String(options["rootDir"])}`,
				},
			})),
		);

		expect(runner.jestConfig).toEqual({
			rootDir: "/repo",
			testEnvironment: "/store/jest-environment-node//repo",
		});
	});

	it("is resolved from cwd where the config names no root", async () => {
		const seen: unknown[] = [];
		await withResolvedEnvironment(
			{ jestConfig: {} },
			"/repo",
			jestConfig(async (options) => {
				seen.push(options["rootDir"]);
				return { options: {} };
			}),
		);

		expect(seen).toEqual(["/repo"]);
	});

	it("is left to Stryker where Jest cannot resolve it", async () => {
		const runner: WithJestConfig = { jestConfig: { testEnvironment: "x" } };

		await withResolvedEnvironment(
			runner,
			"/repo",
			jestConfig(async () => {
				throw new Error("Test environment x cannot be found");
			}),
		);

		expect(runner.jestConfig).toEqual({ testEnvironment: "x" });
	});
});

describe("a Jest baseline with files that did not load", () => {
	const cwd = path.resolve("/sandbox");
	const file = (name: string) => path.join(cwd, "src", name);
	// What Stryker 10's Jest runner returns when a suite fails to run.
	const error: DryRunResult = {
		status: DryRunStatus.Error,
		errorMessage:
			"MODULE_NOT_FOUND Cannot find module './missing' from 'src/broken.test.ts' Error: ...",
	};
	// Jest 30's aggregated results for the same run, as far as they are read.
	const results: JestResults = {
		testResults: [
			{
				testFilePath: file("discount.test.ts"),
				testResults: [
					{ fullName: "q accepts 150", status: "passed", duration: 2 },
					{ fullName: "q is pending", status: "pending" },
					{
						fullName: "q rejects 50",
						status: "failed",
						failureMessages: ["expected false"],
					},
				],
			},
			{
				testFilePath: file("broken.test.ts"),
				testExecError: {
					message:
						"Cannot find module './missing' from 'src/broken.test.ts'\n\n  at ...",
				},
				testResults: [],
			},
			{
				testFilePath: file("empty.test.ts"),
				testExecError: {
					message: "Your test suite must contain at least one test.",
				},
				testResults: [],
			},
		],
	};

	it("adds each file as a failed test named for it, beside the other tests", () => {
		const result = withLoadFailures(error, results, cwd);

		expect(result.status).toBe(DryRunStatus.Complete);
		if (result.status !== DryRunStatus.Complete) return;
		expect(result.tests.map((test) => [test.name, test.status])).toEqual([
			["q accepts 150", TestStatus.Success],
			["q is pending", TestStatus.Skipped],
			["q rejects 50", TestStatus.Failed],
			["src/broken.test.ts (did not load)", TestStatus.Failed],
			["src/empty.test.ts (did not load)", TestStatus.Failed],
		]);
		expect(result.tests[3]).toMatchObject({
			failureMessage:
				"Cannot find module './missing' from 'src/broken.test.ts'",
		});
	});

	it("leaves any other error to Stryker", () => {
		const clean: JestResults = {
			testResults: [{ testFilePath: file("a.test.ts"), testResults: [] }],
		};

		expect(withLoadFailures(error, clean, cwd)).toBe(error);
		expect(withLoadFailures(error, undefined, cwd)).toBe(error);
	});

	it("leaves a baseline that completed alone", () => {
		const complete: DryRunResult = { status: DryRunStatus.Complete, tests: [] };

		expect(withLoadFailures(complete, results, cwd)).toBe(complete);
	});
});
