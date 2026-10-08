/**
 * @module
 * What every runner adapter shares: start a prediction as the run starts,
 * reconcile it as the run ends, say one line, record. Nothing here knows a
 * runner's types.
 *
 * This runs inside someone else's test process, so its rules are not the
 * CLI's. It never throws and never sets an exit code: a failure in variant
 * must not fail a suite. The prediction runs in a child process, so ts-morph
 * never loads beside the tests and a hang there cannot hold them up. And it
 * runs alongside the tests, not before them: nothing is skipped, so the tests
 * do not depend on it.
 */

import { spawn } from "node:child_process";
import {
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHistoryDir } from "../core/history/impact-log.js";
import type { VerifyResult } from "../core/impact/verify.js";
import { testRunFrom, verifyRun } from "../core/impact/verify.js";
import type { Resolution } from "../core/semantic/verdict.js";
import { changeBaseDeps, detectHeadSha } from "../core/vcs/change-base.js";
import { repositoryRoot, resolveCommit } from "../core/vcs/git.js";

export interface ShadowOptions {
	/**
	 * Run outside CI too. By default the adapter is on only when `CI` is set
	 * (or `VARIANT_SHADOW=1`): a local run is often one file, which makes a
	 * poor reconciliation and a line of output nobody asked for.
	 */
	local?: boolean;
	/** Record without printing. */
	silent?: boolean;
	/** How long to wait for the prediction once the tests have ended. */
	timeoutMs?: number;
}

/** One test file's outcome, as the runner reported it. */
export interface FileResult {
	file: string;
	failed: boolean;
}

/** The parts of `impact --json` the adapter reads. */
export interface PredictionSummary {
	resolution: Resolution;
	selectAll: boolean;
	unreached: number;
	unselectedTests: number;
}

export type PredictionOutcome =
	| { kind: "predicted"; summary: PredictionSummary }
	/** Nothing to compare against: not a failure, and not a prediction. */
	| { kind: "none"; reason: string }
	| { kind: "failed"; reason: string };

export interface PredictionHandle {
	result: Promise<PredictionOutcome>;
	cancel: () => void;
}

/** Everything with an effect, so the flow can be tested without processes. */
export interface ShadowDeps {
	env: Readonly<Record<string, string | undefined>>;
	now: () => number;
	repositoryRoot: (cwd: string) => Promise<string>;
	headSha: (root: string) => Promise<string | null>;
	predict: (root: string, headSha: string) => PredictionHandle;
	reconcile: (
		root: string,
		results: readonly FileResult[],
		headSha: string,
	) => Promise<VerifyResult | null>;
	write: (line: string) => void;
	appendSummary: (file: string, text: string) => Promise<void>;
}

export interface ShadowRun {
	/** Reconcile, print and record. Resolves whatever happens. */
	finish: (results: readonly FileResult[]) => Promise<void>;
	/** The run was interrupted: nothing to reconcile. */
	cancel: () => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** A lock this old was left by a process that died; see `acquire`. */
const STALE_LOCK_MS = 10 * 60_000;
const POLL_MS = 200;
/**
 * Well past the window in which another process of the same run reuses an
 * outcome (`STALE_LOCK_MS`), and no longer: nothing reads one after that.
 */
const KEEP_OUTCOME_MS = 60 * 60_000;

const DISABLED: ShadowRun = { finish: async () => {}, cancel: () => {} };

function inCi(env: ShadowDeps["env"]): boolean {
	const ci = env["CI"];
	return ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
}

export function isEnabled(
	options: ShadowOptions,
	env: ShadowDeps["env"],
): boolean {
	if (env["VARIANT_SHADOW"] === "0") return false;
	if (options.local === true || env["VARIANT_SHADOW"] === "1") return true;
	return inCi(env);
}

// ---------------------------------------------------------------- the line

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The one line a run prints. Pure, so every case of it can be read in a test. */
export function summaryLines(
	summary: PredictionSummary,
	result: VerifyResult,
): string[] {
	const why =
		summary.unreached > 0
			? `: ${count(summary.unreached, "changed file")} reach${summary.unreached === 1 ? "es" : ""} no test`
			: summary.unselectedTests > 0
				? `: ${count(summary.unselectedTests, "changed JavaScript test")} could not be selected`
				: "";
	const predicted = summary.selectAll
		? `variant: selected all ${count(result.ranTests, "test file")}, because configuration changed.`
		: `variant: predicted ${result.predictedRan} of ${count(result.ranTests, "test file")} (${summary.resolution}${why}).`;

	const failed = result.failedTests.length;
	if (failed === 0) {
		return [`${predicted} No failures, so nothing to check.`];
	}
	const missed = result.falseSkips.length;
	if (missed === 0) {
		return [
			`${predicted} ${failed} failed, ${failed === 1 ? "and it was" : "all"} predicted.`,
		];
	}
	return [
		`${predicted} ${failed} failed, ${missed} NOT predicted:`,
		...result.falseSkips.map((file) => `  ${file}`),
		"  Nothing was skipped. This is a false skip; please report it.",
	];
}

// ---------------------------------------------------------------- the lock

interface Done {
	at: number;
	outcome: PredictionOutcome;
}

/**
 * A workspace that runs one test process per package starts this adapter once
 * per package, for the same commit. One of them predicts and the rest wait for
 * it: the same prediction N times over would cost N times the work and have N
 * processes writing the symbol index at once.
 *
 * The lock file is the claim. Its holder writes the outcome beside it and
 * then removes it; a waiter reads that outcome once the lock is gone.
 */
function pendingPaths(root: string, headSha: string) {
	const dir = path.join(defaultHistoryDir(root), "pending");
	return {
		dir,
		lock: path.join(dir, `${headSha}.lock`),
		done: path.join(dir, `${headSha}.json`),
	};
}

/** True when this process now holds the lock; otherwise when it was taken. */
async function acquire(
	lock: string,
	dir: string,
	now: () => number,
): Promise<true | number> {
	await mkdir(dir, { recursive: true });
	let takenAt = now();
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(lock, "wx");
			await handle.writeFile(String(now()));
			await handle.close();
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// A process killed mid-run leaves its lock behind. One that old is
			// not a run in progress.
			takenAt = await stat(lock).then(
				(stats) => stats.mtimeMs,
				() => now(),
			);
			if (now() - takenAt < STALE_LOCK_MS) return takenAt;
			await unlink(lock).catch(() => {});
		}
	}
	return takenAt;
}

/**
 * Outcomes are kept one per commit, and CI keeps `.variant/history` in a
 * cache from run to run. Without this they would pile up there for good.
 */
async function prune(dir: string, now: () => number): Promise<void> {
	const names = await readdir(dir).catch(() => []);
	await Promise.all(
		names.map(async (name) => {
			const file = path.join(dir, name);
			const age = await stat(file).then(
				(stats) => now() - stats.mtimeMs,
				() => 0,
			);
			if (age > KEEP_OUTCOME_MS) await unlink(file).catch(() => {});
		}),
	);
}

async function readDone(done: string, since: number): Promise<Done | null> {
	try {
		const parsed = JSON.parse(await readFile(done, "utf8")) as Done;
		// An outcome from an earlier run at this commit is not this run's.
		return parsed.at >= since ? parsed : null;
	} catch {
		return null;
	}
}

// ----------------------------------------------------------------- the run

export function startShadow(
	cwd: string,
	options: ShadowOptions = {},
	deps: ShadowDeps = shadowDeps(),
): ShadowRun {
	if (!isEnabled(options, deps.env)) return DISABLED;

	const startedAt = deps.now();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let cancelled = false;
	let handle: PredictionHandle | undefined;
	let held: string | undefined;

	const say = (lines: readonly string[]): void => {
		if (options.silent !== true) deps.write(`${lines.join("\n")}\n`);
	};

	const release = async (): Promise<void> => {
		if (held === undefined) return;
		const lock = held;
		held = undefined;
		await unlink(lock).catch(() => {});
	};

	// Started now, awaited in `finish`: the tests run while this does.
	const prediction = (async (): Promise<{
		root: string;
		headSha: string;
		outcome: PredictionOutcome;
	} | null> => {
		const root = await deps.repositoryRoot(cwd);
		const headSha = await deps.headSha(root);
		if (headSha === null) return null;
		const paths = pendingPaths(root, headSha);

		// In CI the tree does not change during a job, so a prediction another
		// test process already finished for this commit is this one's too.
		// Locally the tree can change under the same commit, so it is not.
		if (inCi(deps.env)) {
			const earlier = await readDone(paths.done, startedAt - STALE_LOCK_MS);
			if (earlier !== null) return { root, headSha, outcome: earlier.outcome };
		}

		const lock = await acquire(paths.lock, paths.dir, deps.now);
		if (lock === true) {
			held = paths.lock;
			void prune(paths.dir, deps.now);
			handle = deps.predict(root, headSha);
			const outcome = await handle.result;
			const done: Done = { at: deps.now(), outcome };
			await writeFile(paths.done, JSON.stringify(done)).catch(() => {});
			await release();
			return { root, headSha, outcome };
		}

		// Another process is predicting for this commit. Its outcome is ours.
		while (!cancelled) {
			const lockGone = await stat(paths.lock).then(
				() => false,
				() => true,
			);
			if (lockGone) {
				// One second of slack: the two timestamps come from different
				// clocks, the file system's and the process's.
				const done = await readDone(paths.done, lock - 1000);
				return {
					root,
					headSha,
					outcome: done?.outcome ?? {
						kind: "failed",
						reason: "another test process was predicting and left no result",
					},
				};
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
		return null;
	})();
	// Reported in `finish`; unhandled here it would crash the test process.
	prediction.catch(() => {});

	const stop = (): void => {
		cancelled = true;
		handle?.cancel();
		void release();
	};

	return {
		cancel: stop,
		finish: async (results) => {
			try {
				let timer: NodeJS.Timeout | undefined;
				const timedOut = new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), timeoutMs);
				});
				const settled = await Promise.race([prediction, timedOut]);
				clearTimeout(timer);

				if (settled === "timeout") {
					stop();
					say([
						`variant: skipped (the prediction did not finish within ${Math.round(timeoutMs / 1000)} s of the tests)`,
					]);
					return;
				}
				if (settled === null) return;
				const { root, headSha, outcome } = settled;
				if (outcome.kind === "none") {
					say([`variant: no prediction (${outcome.reason})`]);
					return;
				}
				if (outcome.kind === "failed") {
					say([`variant: skipped (${outcome.reason})`]);
					return;
				}

				const result = await deps.reconcile(root, results, headSha);
				if (result === null) {
					say(["variant: skipped (the prediction was not recorded)"]);
					return;
				}
				const lines = summaryLines(outcome.summary, result);
				say(lines);
				const summaryFile = deps.env["GITHUB_STEP_SUMMARY"];
				if (summaryFile !== undefined && summaryFile !== "") {
					await deps
						.appendSummary(summaryFile, `${lines.join("\n")}\n`)
						.catch(() => {});
				}
			} catch (error) {
				stop();
				say([
					`variant: skipped (${error instanceof Error ? error.message : String(error)})`,
				]);
			}
		},
	};
}

// ------------------------------------------------------------ real effects

/** `impact --json`, as far as the adapter reads it. */
interface ImpactJson {
	prediction?: null;
	reason?: string;
	tests?: {
		resolution: Resolution;
		selectAll: boolean;
		unreached: string[];
		unselectedTests: string[];
	};
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line !== "") ?? "variant impact failed"
	);
}

export function parsePrediction(
	exitCode: number | null,
	stdout: string,
	stderr: string,
): PredictionOutcome {
	if (exitCode !== 0) return { kind: "failed", reason: firstLine(stderr) };
	let parsed: ImpactJson;
	try {
		parsed = JSON.parse(stdout) as ImpactJson;
	} catch {
		return { kind: "failed", reason: "variant impact printed no result" };
	}
	if (parsed.prediction === null) {
		return { kind: "none", reason: parsed.reason ?? "nothing to compare" };
	}
	if (parsed.tests === undefined) {
		return { kind: "failed", reason: "variant impact printed no result" };
	}
	return {
		kind: "predicted",
		summary: {
			resolution: parsed.tests.resolution,
			selectAll: parsed.tests.selectAll,
			unreached: parsed.tests.unreached.length,
			unselectedTests: parsed.tests.unselectedTests.length,
		},
	};
}

/**
 * The CLI that ships beside this file. Resolved from here, not from PATH: the
 * adapter and the prediction must be the same build.
 */
function defaultCliPath(): string {
	return fileURLToPath(new URL("./cli.js", import.meta.url));
}

export function shadowDeps(cliPath: string = defaultCliPath()): ShadowDeps {
	return {
		env: process.env,
		now: () => Date.now(),
		repositoryRoot: async (cwd) => (await repositoryRoot(cwd)) ?? cwd,
		headSha: async (root) =>
			(await detectHeadSha(changeBaseDeps(root))) ??
			(await resolveCommit(root, "HEAD")),
		predict: (root, headSha) => {
			const child = spawn(
				process.execPath,
				[cliPath, "impact", "--json", "--head-sha", headSha],
				{ cwd: root, stdio: ["ignore", "pipe", "pipe"] },
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Uint8Array) => {
				stdout += new TextDecoder().decode(chunk);
			});
			child.stderr.on("data", (chunk: Uint8Array) => {
				stderr += new TextDecoder().decode(chunk);
			});
			const result = new Promise<PredictionOutcome>((resolve) => {
				child.on("error", (error) =>
					resolve({ kind: "failed", reason: error.message }),
				);
				child.on("close", (code) =>
					resolve(parsePrediction(code, stdout, stderr)),
				);
			});
			return { result, cancel: () => void child.kill("SIGKILL") };
		},
		reconcile: (root, results, headSha) =>
			verifyRun(root, testRunFrom(root, results), { headSha }),
		write: (line) => void process.stdout.write(line),
		appendSummary: (file, text) => appendFile(file, text),
	};
}
