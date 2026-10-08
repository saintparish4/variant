import { describe, expect, it } from "vitest";
import type { TestModule, Vitest } from "vitest/node";
import type { FileResult, ShadowDeps } from "../shadow.js";
import { variantReporter } from "../vitest.js";

function fakeVitest(watch: boolean): Vitest {
	return {
		config: { root: "/repo", watch },
		logger: { log: () => {} },
	} as unknown as Vitest;
}

function fakeModule(moduleId: string, state: string): TestModule {
	return { moduleId, state: () => state } as unknown as TestModule;
}

function recording(): {
	deps: ShadowDeps;
	reconciled: FileResult[][];
	started: number;
} {
	const record = {
		deps: undefined as unknown as ShadowDeps,
		reconciled: [] as FileResult[][],
		started: 0,
	};
	record.deps = {
		env: { CI: "true" },
		now: () => Date.now(),
		repositoryRoot: async (cwd) => cwd,
		// No commit means no prediction: the hooks are what is under test.
		headSha: async () => {
			record.started++;
			return null;
		},
		predict: () => ({ result: new Promise(() => {}), cancel: () => {} }),
		reconcile: async (_root, results) => {
			record.reconciled.push([...results]);
			return null;
		},
		write: () => {},
		appendSummary: async () => {},
	};
	return record;
}

describe("the Vitest adapter", () => {
	it("starts a run when the tests start", async () => {
		const record = recording();
		const reporter = variantReporter({}, record.deps);

		reporter.onInit?.(fakeVitest(false));
		await reporter.onTestRunStart?.([]);
		await reporter.onTestRunEnd?.([], [], "passed");

		expect(record.started).toBe(1);
	});

	it("stays out of a watch session", async () => {
		const record = recording();
		const reporter = variantReporter({}, record.deps);

		reporter.onInit?.(fakeVitest(true));
		await reporter.onTestRunStart?.([]);
		await reporter.onTestRunEnd?.(
			[fakeModule("/repo/a.test.ts", "failed")],
			[],
			"failed",
		);

		expect(record.started).toBe(0);
	});

	it("does not reconcile a run that was interrupted", async () => {
		const record = recording();
		const reporter = variantReporter({}, record.deps);

		reporter.onInit?.(fakeVitest(false));
		await reporter.onTestRunStart?.([]);
		await reporter.onTestRunEnd?.([], [], "interrupted");

		expect(record.reconciled).toEqual([]);
	});
});
