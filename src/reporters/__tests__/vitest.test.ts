import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestModule, Vitest } from "vitest/node";
import type { FileResult, ShadowDeps } from "../shadow.js";
import { variantReporter, variantReporters } from "../vitest.js";

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

describe("variantReporters", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("is Vitest's default reporter and the adapter", () => {
		vi.stubEnv("GITHUB_ACTIONS", "");
		const reporters = variantReporters();

		expect(reporters).toHaveLength(2);
		expect(reporters[0]).toBe("default");
		expect(reporters[1]).toHaveProperty("onTestRunEnd");
	});

	// Vitest adds this one itself only when no reporters are set, so a config
	// that sets them has to bring it along or lose its annotations.
	it("keeps the annotations Vitest adds by default on GitHub Actions", () => {
		vi.stubEnv("GITHUB_ACTIONS", "true");

		expect(variantReporters().slice(0, 2)).toEqual([
			"default",
			"github-actions",
		]);
	});
});
