/**
 * @module
 * variant's Stryker plugins, loaded by path: Stryker's main process loads
 * the reporter, and each test-runner worker loads the runner.
 *
 * - The reporter forwards what happens, as it happens, to the `variant
 *   check` process over IPC. Streaming is what lets a run stopped at the
 *   limit or the budget keep every result it already has.
 * - The runner is Stryker's own Vitest runner with one thing added: a test
 *   file that fails to load counts as a failing baseline test. Stryker's
 *   runner collects tests only, so such a file contributed nothing and the
 *   baseline read as passing without it (found on pyra).
 */

import type { MutantResult } from "@stryker-mutator/api/core";
import type { Injector, PluginContext } from "@stryker-mutator/api/plugin";
import {
	commonTokens,
	declareClassPlugin,
	declareFactoryPlugin,
	PluginKind,
	tokens,
} from "@stryker-mutator/api/plugin";
import type {
	DryRunCompletedEvent,
	MutationTestingPlanReadyEvent,
	Reporter,
} from "@stryker-mutator/api/report";
import type {
	DryRunResult,
	FailedTestResult,
	SkippedTestResult,
	TestRunner,
} from "@stryker-mutator/api/test-runner";
import { DryRunStatus, TestStatus } from "@stryker-mutator/api/test-runner";
import { strykerPlugins as vitestPlugins } from "@stryker-mutator/vitest-runner";
import type { HostMessage } from "./protocol.js";
import { LOAD_FAILURE_SUFFIX } from "./protocol.js";

function send(message: HostMessage): void {
	process.send?.(message);
}

class VariantReporter implements Reporter {
	onDryRunCompleted(event: DryRunCompletedEvent): void {
		const result = event.result;
		send({
			kind: "baseline",
			tests: (result.status === "complete" ? result.tests : []).map((test) => ({
				id: test.id,
				name: test.name,
				...(test.fileName !== undefined && { fileName: test.fileName }),
				...(test.status === TestStatus.Skipped && { skipped: true }),
			})),
		});
	}

	onMutationTestingPlanReady(event: MutationTestingPlanReadyEvent): void {
		send({
			kind: "plan",
			mutants: event.mutantPlans.map(({ mutant }) => ({
				id: mutant.id,
				fileName: mutant.fileName,
				mutatorName: mutant.mutatorName,
				replacement: mutant.replacement,
				location: mutant.location,
				...(mutant.coveredBy !== undefined && { coveredBy: mutant.coveredBy }),
				...(mutant.static !== undefined && { static: mutant.static }),
			})),
		});
	}

	onMutantTested(result: Readonly<MutantResult>): void {
		send({
			kind: "tested",
			mutant: {
				id: result.id,
				status: result.status,
				...(result.statusReason !== undefined && {
					statusReason: result.statusReason,
				}),
				...(result.killedBy !== undefined && {
					killedBy: [...result.killedBy],
				}),
				...(result.testsCompleted !== undefined && {
					testsCompleted: result.testsCompleted,
				}),
			},
		});
	}
}

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
	declareClassPlugin(PluginKind.Reporter, "variant", VariantReporter),
	declareFactoryPlugin(
		PluginKind.TestRunner,
		"variant-vitest",
		createVitestRunner,
	),
];
