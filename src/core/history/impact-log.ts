/**
 * @module
 * Shadow-mode prediction log (the seed of a shared build history). Every
 * `variant impact` run appends its prediction to
 * `.variant/history/impact.jsonl` so prediction-vs-reality can be measured
 * before test skipping is ever enabled — the measured false-skip rate, not an
 * asserted number, is what earns the right to skip.
 *
 * Logging is best-effort by design: a history write failure must never fail
 * the command, so these functions return booleans / empty lists instead of
 * throwing.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ImpactPrediction {
	/** ISO timestamp of the prediction. */
	at: string;
	baseRef: string;
	/**
	 * The commit the prediction was made against. This is what lets a
	 * prediction be matched to the test run that actually happened — without
	 * it the log records what variant thought, with nothing to check it
	 * against. Null when the working tree is not a git repository.
	 */
	headSha: string | null;
	changedFiles: string[];
	affectedFiles: number;
	affectedPackages: string[];
	/** The predicted run set — reality reconciliation diffs failures against it. */
	affectedTests: string[];
	totalTests: number;
	selectAll: boolean;
	verdict: string;
	confidence: number;
	notes: string[];
}

/**
 * One reconciled run: a prediction checked against what the test runner
 * actually reported. Counts rather than lists — this file accumulates over
 * many runs and the rate is what matters.
 */
export interface ImpactReconciliation {
	at: string;
	headSha: string | null;
	baseRef: string;
	predictedTests: number;
	totalTests: number;
	failedTests: number;
	/** Failures inside the predicted set. */
	caught: number;
	/** Failures outside it — the number that gates test skipping. */
	falseSkips: number;
}

export const MAX_IMPACT_RECORDS = 1000;

const LOG_FILENAME = "impact.jsonl";
const RECONCILIATION_FILENAME = "reconciliation.jsonl";

export function defaultHistoryDir(cwd: string): string {
	return path.join(cwd, ".variant", "history");
}

/**
 * Append one prediction, keeping only the newest MAX_IMPACT_RECORDS entries.
 * Returns false (never throws) when the write fails.
 */
export async function appendImpactPrediction(
	historyDir: string,
	prediction: ImpactPrediction,
): Promise<boolean> {
	return appendRecord(historyDir, LOG_FILENAME, prediction);
}

/**
 * Append one reconciled run. Same best-effort contract as the prediction log:
 * a history write must never fail the command that produced it.
 */
export async function appendReconciliation(
	historyDir: string,
	reconciliation: ImpactReconciliation,
): Promise<boolean> {
	return appendRecord(historyDir, RECONCILIATION_FILENAME, reconciliation);
}

async function appendRecord(
	historyDir: string,
	filename: string,
	record: unknown,
): Promise<boolean> {
	try {
		await mkdir(historyDir, { recursive: true });
		const file = path.join(historyDir, filename);
		let lines: string[] = [];
		try {
			lines = (await readFile(file, "utf8"))
				.split("\n")
				.filter((l) => l.trim() !== "");
		} catch {
			// First write — no log yet.
		}
		lines.push(JSON.stringify(record));
		if (lines.length > MAX_IMPACT_RECORDS) {
			lines = lines.slice(-MAX_IMPACT_RECORDS);
		}
		await writeFile(file, `${lines.join("\n")}\n`);
		return true;
	} catch {
		return false;
	}
}

/** Read the log oldest-first, skipping corrupt lines. [] when missing. */
export async function readImpactPredictions(
	historyDir: string,
): Promise<ImpactPrediction[]> {
	return readRecords<ImpactPrediction>(historyDir, LOG_FILENAME);
}

/** Read reconciled runs oldest-first, skipping corrupt lines. [] when missing. */
export async function readReconciliations(
	historyDir: string,
): Promise<ImpactReconciliation[]> {
	return readRecords<ImpactReconciliation>(historyDir, RECONCILIATION_FILENAME);
}

async function readRecords<T>(
	historyDir: string,
	filename: string,
): Promise<T[]> {
	let raw: string;
	try {
		raw = await readFile(path.join(historyDir, filename), "utf8");
	} catch {
		return [];
	}
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			out.push(JSON.parse(trimmed) as T);
		} catch {
			// Corrupt line (interrupted write) — skip rather than fail.
		}
	}
	return out;
}
