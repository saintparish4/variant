/**
 * @module
 * `variant impact verify` — the other half of shadow mode. `predict.ts` records
 * what variant thought; this reads what actually happened and diffs the two.
 *
 * A failing test the prediction did not select is a **false skip**: had
 * skipping been enabled, that failure would have been missed. That number, over
 * many runs, is the only thing that can earn the right to skip. Everything else
 * `impact` prints is a description of a graph.
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImpactReportError } from "../errors.js";
import type { ImpactPrediction } from "../history/impact-log.js";
import {
	appendReconciliation,
	defaultHistoryDir,
	readImpactPredictions,
} from "../history/impact-log.js";

/**
 * The subset of the Jest JSON report this needs. Vitest's `--reporter=json`
 * emits the same shape, so one parser covers both runners.
 */
interface TestRunReport {
	testResults?: Array<{ name?: unknown; status?: unknown }>;
}

export interface VerifyOptions {
	/** Match this prediction instead of searching by SHA or recency. */
	headSha?: string;
	/** DI for tests: use these predictions instead of reading the log. */
	predictions?: ImpactPrediction[];
	/** DI for tests: skip the history append. */
	log?: boolean;
}

export interface VerifyResult {
	prediction: ImpactPrediction;
	/** How the prediction was located — reported so a mismatch is visible. */
	matchedBy: "head-sha" | "most-recent";
	/** Test files the runner reported as failing, workspace-relative POSIX. */
	failedTests: string[];
	/** Failures the prediction selected. Skipping would not have missed these. */
	caught: string[];
	/** Failures the prediction did NOT select. Skipping would have missed these. */
	falseSkips: string[];
	/**
	 * `falseSkips / failedTests`. Zero when the run had no failures — a clean
	 * run is evidence of nothing, which is why the count matters more than the
	 * rate until many runs accumulate.
	 */
	falseSkipRate: number;
	/** False when the reconciliation could not be persisted. */
	historyLogged: boolean;
}

/** Resolves symlinks, or answers the path unchanged when it does not exist. */
function realpathOrSelf(target: string): string {
	try {
		return realpathSync.native(target);
	} catch {
		return target;
	}
}

function escapes(relative: string): boolean {
	return (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	);
}

/**
 * Normalizes a runner-reported path to the form predictions are keyed by.
 *
 * The runner and variant can name the same workspace by different paths: on
 * macOS getcwd() answers /private/var/... while os.tmpdir() answers /var/....
 * A path that seems to leave the workspace is retried with symlinks resolved;
 * compared lexically, every failure there would be counted as a false skip.
 */
function toRelativePosix(
	cwd: string,
	testPath: string,
	realpath: (target: string) => string,
): string {
	let relative = testPath;
	if (path.isAbsolute(testPath)) {
		relative = path.relative(cwd, testPath);
		if (escapes(relative)) {
			relative = path.relative(realpath(cwd), realpath(testPath));
		}
	}
	return relative.replace(/\\/g, "/");
}

/**
 * Failing test files from a Jest/Vitest JSON report. Entries that do not match
 * the expected shape are skipped rather than throwing: a runner adding a field
 * must not break reconciliation, and a report with no recognizable failures is
 * a legitimate result (everything passed).
 */
export function parseFailedTests(
	cwd: string,
	raw: string,
	realpath: (target: string) => string = realpathOrSelf,
): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ImpactReportError("it is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new ImpactReportError("it is not a JSON object");
	}
	const results = (parsed as TestRunReport).testResults;
	if (!Array.isArray(results)) {
		throw new ImpactReportError("it has no `testResults` array");
	}

	const failed: string[] = [];
	for (const entry of results) {
		if (typeof entry !== "object" || entry === null) continue;
		const { name, status } = entry;
		if (status !== "failed" || typeof name !== "string") continue;
		failed.push(toRelativePosix(cwd, name, realpath));
	}
	return [...new Set(failed)].sort();
}

/**
 * The whole judgement, with no I/O: which failures the prediction would have
 * run, and which it would have skipped.
 */
export function reconcile(
	prediction: ImpactPrediction,
	failedTests: readonly string[],
): Pick<VerifyResult, "caught" | "falseSkips" | "falseSkipRate"> {
	const selected = new Set(prediction.affectedTests);
	const caught: string[] = [];
	const falseSkips: string[] = [];
	for (const test of failedTests) {
		// `selectAll` means nothing was going to be skipped, so no failure can
		// be a false skip whatever the recorded set happens to contain.
		if (prediction.selectAll || selected.has(test)) caught.push(test);
		else falseSkips.push(test);
	}
	return {
		caught,
		falseSkips,
		falseSkipRate:
			failedTests.length === 0 ? 0 : falseSkips.length / failedTests.length,
	};
}

function selectPrediction(
	predictions: readonly ImpactPrediction[],
	headSha: string | undefined,
): {
	prediction: ImpactPrediction;
	matchedBy: VerifyResult["matchedBy"];
} | null {
	if (headSha !== undefined) {
		// Newest first: a SHA can be predicted against more than once.
		for (let i = predictions.length - 1; i >= 0; i--) {
			const candidate = predictions[i];
			if (candidate?.headSha === headSha) {
				return { prediction: candidate, matchedBy: "head-sha" };
			}
		}
		return null;
	}
	const latest = predictions[predictions.length - 1];
	return latest === undefined
		? null
		: { prediction: latest, matchedBy: "most-recent" };
}

/**
 * A report that cannot be read is the same mistake as one that cannot be
 * parsed: a path from the user, not a fault in variant.
 */
async function readReport(cwd: string, reportPath: string): Promise<string> {
	try {
		return await readFile(path.resolve(cwd, reportPath), "utf8");
	} catch (error) {
		const code =
			error instanceof Error && "code" in error ? String(error.code) : "";
		throw new ImpactReportError(
			code === "ENOENT"
				? `no file at ${reportPath}`
				: `${reportPath} could not be read${code === "" ? "" : ` (${code})`}`,
		);
	}
}

/**
 * Returns null when no prediction can be matched — there is nothing to
 * reconcile against, which is a different answer from "no false skips".
 */
export async function verifyImpact(
	cwd: string,
	reportPaths: string | readonly string[],
	options: VerifyOptions = {},
): Promise<VerifyResult | null> {
	const historyDir = defaultHistoryDir(cwd);
	const predictions =
		options.predictions ?? (await readImpactPredictions(historyDir));

	const match = selectPrediction(predictions, options.headSha);
	if (match === null) return null;

	// A workspace that runs each package's suite on its own writes one report
	// per package for a single run. A file failing in any of them failed.
	const paths = typeof reportPaths === "string" ? [reportPaths] : reportPaths;
	const reports = await Promise.all(
		paths.map((reportPath) => readReport(cwd, reportPath)),
	);
	const failedTests = [
		...new Set(reports.flatMap((raw) => parseFailedTests(cwd, raw))),
	].sort();

	const { caught, falseSkips, falseSkipRate } = reconcile(
		match.prediction,
		failedTests,
	);

	const historyLogged =
		options.log === false
			? true
			: await appendReconciliation(historyDir, {
					at: new Date().toISOString(),
					headSha: match.prediction.headSha,
					baseRef: match.prediction.baseRef,
					predictedTests: match.prediction.affectedTests.length,
					totalTests: match.prediction.totalTests,
					failedTests: failedTests.length,
					caught: caught.length,
					falseSkips: falseSkips.length,
					confidence: match.prediction.confidence,
					selectAll: match.prediction.selectAll,
				});

	return {
		prediction: match.prediction,
		matchedBy: match.matchedBy,
		failedTests,
		caught,
		falseSkips,
		falseSkipRate,
		historyLogged,
	};
}
