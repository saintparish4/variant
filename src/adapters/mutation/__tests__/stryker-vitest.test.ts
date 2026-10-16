import type {
	DryRunResult,
	TestResult,
	TestRunner,
} from "@stryker-mutator/api/test-runner";
import { DryRunStatus, TestStatus } from "@stryker-mutator/api/test-runner";
import { describe, expect, it } from "vitest";
import { DID_NOT_LOAD } from "../../../core/errors.js";
import { LOAD_FAILURE_SUFFIX } from "../protocol.js";
import { withLoadFailures } from "../stryker-vitest.js";

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

describe("LOAD_FAILURE_SUFFIX", () => {
	it("is the suffix core reads a file that did not load by", () => {
		expect(LOAD_FAILURE_SUFFIX).toBe(DID_NOT_LOAD);
	});
});

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

	// pyra: `describe.skipIf` tests never reached the baseline, so the report
	// could not say any were skipped.
	it("adds the tests Vitest skipped, which Stryker's runner leaves out", () => {
		const result = withLoadFailures(
			passing,
			runnerWith([
				{
					name: "scripts/generate.test.ts",
					filepath: "/p/scripts/generate.test.ts",
					result: {},
					tasks: [
						{
							type: "suite",
							tasks: [
								{ type: "test", id: "g1", name: "builds", mode: "skip" },
								{
									type: "test",
									id: "g2",
									name: "runs",
									mode: "run",
									result: {},
								},
							],
						},
					],
				},
			]),
		);

		expect(result.status === DryRunStatus.Complete && result.tests).toEqual([
			test,
			expect.objectContaining({
				id: "g1",
				name: "builds",
				status: TestStatus.Skipped,
			}),
		]);
	});

	// pyra: no mutated code ran, every file recorded nothing, and Stryker took
	// the missing coverage for "coverage off".
	it("turns no coverage into empty coverage when Stryker's setup ran and found nothing", () => {
		const result = withLoadFailures(
			passing,
			runnerWith([
				{ name: "a.test.ts", result: {}, meta: { mutantCoverage: undefined } },
			]),
		);

		expect(
			result.status === DryRunStatus.Complete && result.mutantCoverage,
		).toEqual({
			static: {},
			perTest: {},
		});
	});

	it("leaves coverage unknown when nothing shows Stryker's setup ran", () => {
		const result = withLoadFailures(
			passing,
			runnerWith([{ name: "a.test.ts", result: {}, meta: {} }]),
		);

		expect(
			result.status === DryRunStatus.Complete && result.mutantCoverage,
		).toBeUndefined();
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
