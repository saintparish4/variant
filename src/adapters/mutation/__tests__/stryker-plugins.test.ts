import type {
	DryRunResult,
	TestResult,
	TestRunner,
} from "@stryker-mutator/api/test-runner";
import { DryRunStatus, TestStatus } from "@stryker-mutator/api/test-runner";
import { describe, expect, it } from "vitest";
import { withLoadFailures } from "../stryker-plugins.js";

function runnerWith(files: unknown[]): TestRunner {
	return {
		capabilities: () => ({ reloadEnvironment: true }),
		dryRun: async () => ({ status: DryRunStatus.Complete, tests: [] }),
		mutantRun: async () => {
			throw new Error("not used");
		},
		ctx: { state: { getFiles: () => files } },
	} as TestRunner;
}

const test: TestResult = {
	id: "a",
	name: "a",
	status: TestStatus.Success,
	timeSpentMs: 1,
};
const passing: DryRunResult = { status: DryRunStatus.Complete, tests: [test] };

describe("withLoadFailures", () => {
	it("adds a failed test for a file whose errors sit on the file itself", () => {
		const result = withLoadFailures(
			passing,
			runnerWith([
				{
					name: "src/dictionary.test.ts",
					result: {
						errors: [{ message: "Cannot find module './generated'\n  at …" }],
					},
				},
				{ name: "src/ok.test.ts", result: {} },
			]),
		);

		expect(result.status === DryRunStatus.Complete && result.tests).toEqual([
			test,
			expect.objectContaining({
				name: "src/dictionary.test.ts (did not load)",
				status: TestStatus.Failed,
				failureMessage: "Cannot find module './generated'",
			}),
		]);
	});

	it("leaves a baseline whose files all loaded as it was", () => {
		expect(
			withLoadFailures(passing, runnerWith([{ name: "x", result: {} }])),
		).toBe(passing);
	});

	it("leaves a run that already errored as it was", () => {
		const errored: DryRunResult = {
			status: DryRunStatus.Error,
			errorMessage: "boom",
		};
		expect(withLoadFailures(errored, runnerWith([]))).toBe(errored);
	});
});
