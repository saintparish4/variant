/**
 * @module
 * A Stryker reporter plugin that forwards what happens, as it happens, to the
 * `variant check` process over IPC. Streaming is what lets a run stopped at
 * the limit or the budget keep every result it already has.
 */

import type { MutantResult } from "@stryker-mutator/api/core";
import { declareClassPlugin, PluginKind } from "@stryker-mutator/api/plugin";
import type {
	DryRunCompletedEvent,
	MutationTestingPlanReadyEvent,
	Reporter,
} from "@stryker-mutator/api/report";
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
