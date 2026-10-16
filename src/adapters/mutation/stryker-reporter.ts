/**
 * @module
 * variant's Stryker reporter, loaded by path in Stryker's main process. It
 * forwards what happens, as it happens, to the `variant check` process over
 * IPC. Streaming is what lets a run stopped at the limit or the budget keep
 * every result it already has.
 *
 * It knows no test runner: each runner's plugin is a module of its own,
 * because Stryker loads every plugin module in every worker, and a Jest
 * package has no Vitest to load.
 */

import type { MutantResult } from "@stryker-mutator/api/core";
import { declareClassPlugin, PluginKind } from "@stryker-mutator/api/plugin";
import type {
	DryRunCompletedEvent,
	MutationTestingPlanReadyEvent,
	Reporter,
} from "@stryker-mutator/api/report";
import { TestStatus } from "@stryker-mutator/api/test-runner";
import type { HostMessage } from "./protocol.js";

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

export const strykerPlugins = [
	declareClassPlugin(PluginKind.Reporter, "variant", VariantReporter),
];
