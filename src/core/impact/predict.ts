/**
 * @module
 * `variant impact` — the headline prediction: which tests a
 * change requires, from the full change-intelligence pipeline (signature differ → blast
 * radius → test impact).
 *
 * REPORT-ONLY by design. Every run appends its prediction to
 * `.variant/history/impact.jsonl`; the measured false-skip rate over those
 * shadow runs is what earns the right to actually skip tests. The confidence
 * this returns is a graph-resolution score, not a promise.
 */

import { loadPackageGraph } from "../graph/package-graph.js";
import {
	appendImpactPrediction,
	defaultHistoryDir,
} from "../history/impact-log.js";
import type { TraceBlastRadiusOptions } from "../semantic/blast-radius.js";
import type { TestImpactResult } from "../semantic/test-impact.js";
import { traceTestImpact } from "../semantic/test-impact.js";
import type { BuildVerdict } from "../semantic/verdict.js";
import { deriveVerdict } from "../semantic/verdict.js";
import { readHeadSha } from "../vcs/git.js";

export const DEFAULT_IMPACT_BASE_REF = "HEAD~1";

export interface ImpactOptions {
	base?: string;
	/** DI for tests: skip git and use these workspace-relative paths. */
	changedFiles?: string[];
	/** DI for tests: content of a file at baseRef. */
	readBefore?: TraceBlastRadiusOptions["readBefore"];
	/** DI for tests: the head SHA to record, instead of asking git. */
	headSha?: string | null;
}

export interface ImpactReport {
	baseRef: string;
	result: TestImpactResult;
	verdict: BuildVerdict;
	/** False when the shadow-mode prediction could not be persisted. */
	historyLogged: boolean;
}

/**
 * Returns null when the changed set is unavailable (no git, or a ref with no
 * prior commit), mirroring `traceBlastRadius`.
 */
export async function predictImpact(
	cwd: string,
	options: ImpactOptions = {},
): Promise<ImpactReport | null> {
	const baseRef = options.base ?? DEFAULT_IMPACT_BASE_REF;
	const packageGraph = await loadPackageGraph(cwd).catch(() => undefined);

	const result = await traceTestImpact(cwd, {
		baseRef,
		...(packageGraph !== undefined && { packageGraph }),
		...(options.changedFiles !== undefined && {
			changedFiles: options.changedFiles,
		}),
		...(options.readBefore !== undefined && { readBefore: options.readBefore }),
	});
	if (result === null) return null;

	const verdict = deriveVerdict(
		result.radius.changed.map((change) => change.classification),
		{ forceBuild: result.tests.selectAll },
	);

	const headSha =
		options.headSha !== undefined ? options.headSha : await readHeadSha(cwd);

	const historyLogged = await appendImpactPrediction(defaultHistoryDir(cwd), {
		at: new Date().toISOString(),
		baseRef,
		headSha,
		changedFiles: result.radius.changed.map((change) => change.filePath),
		affectedFiles: result.radius.affectedFiles.length,
		affectedPackages: result.radius.affectedPackages,
		affectedTests: result.tests.affectedTests,
		totalTests: result.tests.totalTests,
		selectAll: result.tests.selectAll,
		verdict,
		confidence: result.tests.confidence,
		notes: [...result.radius.notes, ...result.tests.notes],
	});

	return { baseRef, result, verdict, historyLogged };
}
