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

import { GitRefError, NoTestFilesError } from "../errors.js";
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
import { assertBaseRef } from "../vcs/base-ref.js";
import type {
	BaseSource,
	ChangeBase,
	ChangeBaseDeps,
} from "../vcs/change-base.js";
import { changeBaseDeps, resolveChangeBase } from "../vcs/change-base.js";
import { readHeadSha } from "../vcs/git.js";

export const DEFAULT_IMPACT_BASE_REF = "HEAD~1";

export interface ImpactOptions {
	/**
	 * Ref to compare against. Worked out from git and the CI environment when
	 * omitted; see `resolveChangeBase`.
	 */
	base?: string;
	/** DI for tests: what base detection reads. */
	changeBaseDeps?: ChangeBaseDeps;
	/** DI for tests: skip git and use these workspace-relative paths. */
	changedFiles?: string[];
	/** DI for tests: content of a file at baseRef. */
	readBefore?: TraceBlastRadiusOptions["readBefore"];
	/**
	 * The commit to record the prediction against, instead of asking git for
	 * HEAD. In a pull request CI checks out a merge commit made for the run;
	 * the pushed commit is the one a person can look up afterwards.
	 */
	headSha?: string | null;
}

export interface ImpactReport {
	baseRef: string;
	/** How `baseRef` was chosen, and what it stands for in words. */
	baseSource: BaseSource;
	baseLabel: string;
	result: TestImpactResult;
	verdict: BuildVerdict;
	/**
	 * Workspace packages discovery found. Printed so that "none" in a monorepo
	 * is visible: bare imports of an undiscovered package count as external.
	 */
	packagesFound: number;
	/** False when the shadow-mode prediction could not be persisted. */
	historyLogged: boolean;
}

/**
 * Throws `GitRefError` when the changed set cannot be listed, and
 * `NoTestFilesError` when no test file is indexed: an empty prediction in
 * either case would read as "run nothing".
 */
export async function predictImpact(
	cwd: string,
	options: ImpactOptions = {},
): Promise<ImpactReport> {
	// An injected change set has no diff to take, so no base to detect.
	const base: ChangeBase =
		options.changedFiles === undefined
			? await resolveChangeBase(
					options.base,
					options.changeBaseDeps ?? changeBaseDeps(cwd),
				)
			: {
					ref: options.base ?? DEFAULT_IMPACT_BASE_REF,
					source: options.base === undefined ? "previous-commit" : "flag",
					label: options.base ?? "previous commit",
				};
	const baseRef = base.ref;
	if (options.changedFiles === undefined) await assertBaseRef(cwd, baseRef);
	const packageGraph = await loadPackageGraph(cwd).catch(() => undefined);

	const result = await traceTestImpact(cwd, {
		baseRef,
		...(packageGraph !== undefined && { packageGraph }),
		...(options.changedFiles !== undefined && {
			changedFiles: options.changedFiles,
		}),
		...(options.readBefore !== undefined && { readBefore: options.readBefore }),
	});
	if (result === null) {
		throw new GitRefError(
			`Could not list the files changed since "${baseRef}"`,
		);
	}
	// "0 of 0" is not a prediction, and logged it would count as a clean run.
	if (result.tests.totalTests === 0) throw new NoTestFilesError();

	const verdict = deriveVerdict(
		result.radius.changed.map((change) => change.classification),
		{ forceBuild: result.tests.selectAll },
	);

	const headSha =
		options.headSha !== undefined
			? options.headSha
			: (base.headSha ?? (await readHeadSha(cwd)));

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

	return {
		baseRef,
		baseSource: base.source,
		baseLabel: base.label,
		result,
		verdict,
		packagesFound: packageGraph?.packages.length ?? 0,
		historyLogged,
	};
}
