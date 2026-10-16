/**
 * @module
 * Stryker's own Vitest runner, loaded by path in each test-runner worker,
 * with what it leaves out of the baseline added back:
 *
 * - A test file that fails to load counts as a failing baseline test.
 *   Stryker's runner collects tests only, so such a file contributed nothing
 *   and the baseline read as passing without it (found on pyra).
 * - Skipped tests are counted.
 * - Coverage of nothing is coverage, not coverage analysis turned off.
 */

import type { Injector, PluginContext } from "@stryker-mutator/api/plugin";
import {
	commonTokens,
	declareFactoryPlugin,
	PluginKind,
	tokens,
} from "@stryker-mutator/api/plugin";
import type {
	DryRunResult,
	FailedTestResult,
	SkippedTestResult,
	TestRunner,
} from "@stryker-mutator/api/test-runner";
import { DryRunStatus, TestStatus } from "@stryker-mutator/api/test-runner";
import { strykerPlugins as vitestPlugins } from "@stryker-mutator/vitest-runner";
import { LOAD_FAILURE_SUFFIX } from "./protocol.js";

/** The parts of a Vitest task this reads: a file, a suite or a test. */
interface VitestTask {
	type?: string;
	id?: string;
	name?: string;
	mode?: string;
	result?: unknown;
	tasks?: VitestTask[];
}

interface VitestFile extends VitestTask {
	filepath?: string;
	result?: { errors?: ReadonlyArray<{ message?: string }> };
	meta?: Record<string, unknown>;
}

/**
 * Stryker's setup records each file's coverage on `meta.mutantCoverage`, as
 * whatever the instrumented code collected: nothing at all when no mutated
 * code ran. With every file empty its runner returns no coverage, which
 * Stryker reads as "coverage analysis off": every mutant then ran against
 * every test, and code no test imports read as undetected (found on pyra).
 *
 * The key is set even when empty, so a file that has it shows the setup ran
 * and found nothing: that is coverage, of nothing. A file without it says
 * nothing either way.
 */
export function measuredNothing(runner: TestRunner): boolean {
	const files = (runner as WithVitest).ctx?.state?.getFiles?.() ?? [];
	return files.some(
		(file) =>
			file.meta !== undefined && Object.hasOwn(file.meta, "mutantCoverage"),
	);
}

/**
 * Tests Vitest skipped (`skip`, `skipIf`, `todo`). They have no result, and
 * Stryker's runner keeps only tests with one, so without these the report
 * could not say that any were skipped.
 */
export function skippedTests(runner: TestRunner): SkippedTestResult[] {
	const files = (runner as WithVitest).ctx?.state?.getFiles?.() ?? [];
	const out: SkippedTestResult[] = [];
	const walk = (task: VitestTask, file: VitestFile): void => {
		if (task.type === "test") {
			if (
				task.result === undefined &&
				(task.mode === "skip" || task.mode === "todo")
			) {
				out.push({
					id: task.id ?? `${file.name ?? ""}#${task.name ?? ""}`,
					name: task.name ?? "a skipped test",
					status: TestStatus.Skipped,
					timeSpentMs: 0,
					...(file.filepath !== undefined && { fileName: file.filepath }),
				});
			}
			return;
		}
		for (const child of task.tasks ?? []) walk(child, file);
	};
	for (const file of files) walk(file, file);
	return out;
}

/** Stryker's Vitest runner keeps its Vitest instance in a public field. */
interface WithVitest {
	ctx?: { state?: { getFiles?: () => VitestFile[] } };
}

/**
 * Files Vitest could not run at all: an import that fails, a `beforeAll` at
 * the top of the file that throws. Their errors sit on the file, not on a
 * test, which is where Stryker's runner looks.
 */
export function filesThatDidNotLoad(runner: TestRunner): FailedTestResult[] {
	const files = (runner as WithVitest).ctx?.state?.getFiles?.() ?? [];
	return files
		.filter((file) => (file.result?.errors?.length ?? 0) > 0)
		.map((file) => {
			const name = file.name ?? file.filepath ?? "a test file";
			return {
				id: `${name}#variant-load`,
				name: `${name}${LOAD_FAILURE_SUFFIX}`,
				status: TestStatus.Failed,
				failureMessage:
					file.result?.errors?.[0]?.message?.split("\n")[0] ??
					"the file failed to load",
				timeSpentMs: 0,
				...(file.filepath !== undefined && { fileName: file.filepath }),
			};
		});
}

/** The baseline as Vitest saw it: files that did not load fail it, and skipped tests are counted. */
export function withLoadFailures(
	result: DryRunResult,
	runner: TestRunner,
): DryRunResult {
	if (result.status !== DryRunStatus.Complete) return result;
	const added = [...filesThatDidNotLoad(runner), ...skippedTests(runner)];
	const coverage =
		result.mutantCoverage === undefined && measuredNothing(runner)
			? { mutantCoverage: { static: {}, perTest: {} } }
			: {};
	return added.length === 0 && Object.keys(coverage).length === 0
		? result
		: { ...result, ...coverage, tests: [...result.tests, ...added] };
}

const vitest = vitestPlugins.find(
	(plugin) => plugin.kind === PluginKind.TestRunner && plugin.name === "vitest",
);

function createVitestRunner(injector: Injector<PluginContext>): TestRunner {
	if (vitest === undefined || !("factory" in vitest)) {
		throw new Error("@stryker-mutator/vitest-runner has no Vitest runner");
	}
	const runner = injector.injectFunction(vitest.factory) as TestRunner;
	return {
		capabilities: () => runner.capabilities(),
		init: async () => runner.init?.(),
		dryRun: async (options) =>
			withLoadFailures(await runner.dryRun(options), runner),
		mutantRun: (options) => runner.mutantRun(options),
		dispose: async () => runner.dispose?.(),
	};
}
createVitestRunner.inject = tokens(commonTokens.injector);

export const strykerPlugins = [
	declareFactoryPlugin(
		PluginKind.TestRunner,
		"variant-vitest",
		createVitestRunner,
	),
];
