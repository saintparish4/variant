import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerifyResult } from "../../core/impact/verify.js";
import type {
	FileResult,
	PredictionOutcome,
	PredictionSummary,
	ShadowDeps,
} from "../shadow.js";
import {
	isEnabled,
	parsePrediction,
	startShadow,
	summaryLines,
} from "../shadow.js";

const HEAD = "a".repeat(40);

const dirs: string[] = [];
function tempRoot(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-shadow-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const SUMMARY: PredictionSummary = {
	resolution: "high",
	selectAll: false,
	unreached: 0,
	unselectedTests: 0,
};

function verified(overrides: Partial<VerifyResult> = {}): VerifyResult {
	return {
		prediction: {
			at: "2026-01-01T00:00:00.000Z",
			baseRef: "HEAD~1",
			headSha: HEAD,
			changedFiles: [],
			affectedFiles: 0,
			affectedPackages: [],
			affectedTests: [],
			totalTests: 55,
			selectAll: false,
			verdict: "build-recommended",
			confidence: 1,
			notes: [],
		},
		matchedBy: "head-sha",
		failedTests: [],
		caught: [],
		falseSkips: [],
		falseSkipRate: 0,
		ranTests: 55,
		predictedRan: 8,
		historyLogged: true,
		...overrides,
	};
}

interface Harness {
	deps: ShadowDeps;
	written: string[];
	summaries: string[];
	predictions: number;
	reconciled: FileResult[][];
}

function harness(
	root: string,
	options: {
		outcome?: PredictionOutcome | Promise<PredictionOutcome>;
		result?: VerifyResult | null;
		env?: Record<string, string>;
	} = {},
): Harness {
	const state: Harness = {
		deps: undefined as unknown as ShadowDeps,
		written: [],
		summaries: [],
		predictions: 0,
		reconciled: [],
	};
	state.deps = {
		env: { CI: "true", ...options.env },
		now: () => Date.now(),
		repositoryRoot: async () => root,
		headSha: async () => HEAD,
		predict: () => {
			state.predictions++;
			return {
				result: Promise.resolve(
					options.outcome ?? { kind: "predicted", summary: SUMMARY },
				),
				cancel: () => {},
			};
		},
		reconcile: async (_root, results) => {
			state.reconciled.push([...results]);
			return options.result === undefined ? verified() : options.result;
		},
		write: (line) => void state.written.push(line),
		appendSummary: async (_file, text) => void state.summaries.push(text),
	};
	return state;
}

describe("isEnabled", () => {
	it.each([
		["in CI", {}, { CI: "true" }, true],
		["locally by default", {}, {}, false],
		["locally when asked for in the config", { local: true }, {}, true],
		[
			"locally when asked for in the environment",
			{},
			{ VARIANT_SHADOW: "1" },
			true,
		],
		["in CI when switched off", {}, { CI: "true", VARIANT_SHADOW: "0" }, false],
		["when CI is set to false", {}, { CI: "false" }, false],
	])("is %s: %j %j", (_, options, env, expected) => {
		expect(isEnabled(options, env)).toBe(expected);
	});
});

describe("summaryLines", () => {
	it("says there was nothing to check when nothing failed", () => {
		expect(summaryLines(SUMMARY, verified())).toEqual([
			"variant: predicted 8 of 55 test files (high). No failures, so nothing to check.",
		]);
	});

	it("says every failure was predicted", () => {
		expect(
			summaryLines(
				SUMMARY,
				verified({
					failedTests: ["a.test.ts", "b.test.ts"],
					caught: ["a.test.ts", "b.test.ts"],
				}),
			),
		).toEqual([
			"variant: predicted 8 of 55 test files (high). 2 failed, all predicted.",
		]);
	});

	it("names a failure it did not predict, and says nothing was skipped", () => {
		expect(
			summaryLines(
				SUMMARY,
				verified({
					failedTests: ["a.test.ts", "src/billing/invoice.test.ts"],
					caught: ["a.test.ts"],
					falseSkips: ["src/billing/invoice.test.ts"],
				}),
			),
		).toEqual([
			"variant: predicted 8 of 55 test files (high). 2 failed, 1 NOT predicted:",
			"  src/billing/invoice.test.ts",
			"  Nothing was skipped. This is a false skip; please report it.",
		]);
	});

	it("gives the reason when it is not confident", () => {
		expect(
			summaryLines(
				{ ...SUMMARY, resolution: "low", unreached: 3 },
				verified({ predictedRan: 0 }),
			)[0],
		).toBe(
			"variant: predicted 0 of 55 test files (low: 3 changed files reach no test). No failures, so nothing to check.",
		);
	});

	it("says when everything was selected", () => {
		expect(
			summaryLines(
				{ ...SUMMARY, selectAll: true },
				verified({ predictedRan: 55 }),
			)[0],
		).toBe(
			"variant: selected all 55 test files, because configuration changed. No failures, so nothing to check.",
		);
	});
});

describe("parsePrediction", () => {
	it("reads what the adapter needs from impact --json", () => {
		expect(
			parsePrediction(
				0,
				JSON.stringify({
					tests: {
						resolution: "low",
						selectAll: false,
						unreached: ["a.rs"],
						unselectedTests: [],
					},
				}),
				"",
			),
		).toEqual({
			kind: "predicted",
			summary: {
				resolution: "low",
				selectAll: false,
				unreached: 1,
				unselectedTests: 0,
			},
		});
	});

	it("tells a push with nothing to compare against from a failure", () => {
		expect(
			parsePrediction(
				0,
				JSON.stringify({
					prediction: null,
					reason: "This push has no previous commit",
				}),
				"",
			),
		).toEqual({ kind: "none", reason: "This push has no previous commit" });
	});

	it("carries the first line of an error", () => {
		expect(
			parsePrediction(
				1,
				"",
				'\n[GIT_REF_ERROR] "origin/main" is not in this clone\n  Hint: ...\n',
			),
		).toEqual({
			kind: "failed",
			reason: '[GIT_REF_ERROR] "origin/main" is not in this clone',
		});
	});
});

describe("startShadow", () => {
	const RESULTS: FileResult[] = [{ file: "/r/a.test.ts", failed: false }];

	it("does nothing at all when it is not enabled", async () => {
		const h = harness(tempRoot(), { env: { CI: "" } });

		await startShadow("/r", {}, h.deps).finish(RESULTS);

		expect(h.predictions).toBe(0);
		expect(h.written).toEqual([]);
	});

	it("predicts alongside the run, reconciles at the end, and says one line", async () => {
		const h = harness(tempRoot());

		const run = startShadow("/r", {}, h.deps);
		await run.finish(RESULTS);

		expect(h.predictions).toBe(1);
		expect(h.reconciled).toEqual([RESULTS]);
		expect(h.written).toEqual([
			"variant: predicted 8 of 55 test files (high). No failures, so nothing to check.\n",
		]);
	});

	it("also writes the line to the GitHub job summary", async () => {
		const h = harness(tempRoot(), {
			env: { GITHUB_STEP_SUMMARY: "/summary.md" },
		});

		await startShadow("/r", {}, h.deps).finish(RESULTS);

		expect(h.summaries).toHaveLength(1);
	});

	it("records without printing when silent", async () => {
		const h = harness(tempRoot());

		await startShadow("/r", { silent: true }, h.deps).finish(RESULTS);

		expect(h.reconciled).toHaveLength(1);
		expect(h.written).toEqual([]);
	});

	it("says there was nothing to compare against, and reconciles nothing", async () => {
		const h = harness(tempRoot(), {
			outcome: { kind: "none", reason: "This push has no previous commit" },
		});

		await startShadow("/r", {}, h.deps).finish(RESULTS);

		expect(h.reconciled).toEqual([]);
		expect(h.written).toEqual([
			"variant: no prediction (This push has no previous commit)\n",
		]);
	});

	it("reports a failed prediction in one line and does not throw", async () => {
		const h = harness(tempRoot(), {
			outcome: { kind: "failed", reason: "[GIT_REF_ERROR] no base" },
		});

		await expect(
			startShadow("/r", {}, h.deps).finish(RESULTS),
		).resolves.toBeUndefined();

		expect(h.written).toEqual(["variant: skipped ([GIT_REF_ERROR] no base)\n"]);
	});

	it("does not throw when reconciling does", async () => {
		const h = harness(tempRoot());
		h.deps.reconcile = async () => {
			throw new Error("disk full");
		};

		await expect(
			startShadow("/r", {}, h.deps).finish(RESULTS),
		).resolves.toBeUndefined();

		expect(h.written).toEqual(["variant: skipped (disk full)\n"]);
	});

	it("gives up on a prediction that outlasts the tests by too long", async () => {
		let cancelled = false;
		let started: () => void = () => {};
		const predicting = new Promise<void>((resolve) => {
			started = resolve;
		});
		const h = harness(tempRoot());
		h.deps.predict = () => {
			started();
			return {
				result: new Promise(() => {}),
				cancel: () => {
					cancelled = true;
				},
			};
		};

		const run = startShadow("/r", { timeoutMs: 20 }, h.deps);
		// The tests end after the prediction began; how long the file system
		// takes to get there is not what this is about.
		await predicting;
		await run.finish(RESULTS);

		expect(cancelled).toBe(true);
		expect(h.written[0]).toContain(
			"variant: skipped (the prediction did not finish",
		);
	});

	// On a slow file system the run can give up before the prediction has
	// even started. Started afterwards, it was a child process nobody would
	// ever stop.
	it("starts no prediction once the run has given up on it", async () => {
		const root = tempRoot();
		const h = harness(root);
		h.deps.repositoryRoot = async () => {
			await new Promise((resolve) => setTimeout(resolve, 80));
			return root;
		};

		await startShadow("/r", { timeoutMs: 20 }, h.deps).finish(RESULTS);
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(h.predictions).toBe(0);
		expect(h.written[0]).toContain(
			"variant: skipped (the prediction did not finish",
		);
		expect(existsSync(path.join(root, ".variant/history/pending"))).toBe(false);
	});

	// One test process per package: every one of them starts the adapter for
	// the same commit. One predicts; the rest take its result.
	it("predicts once when several test processes start for the same commit", async () => {
		const root = tempRoot();
		let finishPrediction: (outcome: PredictionOutcome) => void = () => {};
		const slow = new Promise<PredictionOutcome>((resolve) => {
			finishPrediction = resolve;
		});
		const first = harness(root, { outcome: slow });
		const second = harness(root);

		const leader = startShadow("/r/packages/a", {}, first.deps);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const follower = startShadow("/r/packages/b", {}, second.deps);
		await new Promise((resolve) => setTimeout(resolve, 50));
		finishPrediction({ kind: "predicted", summary: SUMMARY });
		await Promise.all([leader.finish(RESULTS), follower.finish(RESULTS)]);

		expect(first.predictions + second.predictions).toBe(1);
		expect(first.reconciled).toHaveLength(1);
		expect(second.reconciled).toHaveLength(1);
	});

	it("reuses a prediction another process already finished, in CI", async () => {
		const root = tempRoot();
		const first = harness(root);
		const second = harness(root);

		await startShadow("/r/packages/a", {}, first.deps).finish(RESULTS);
		await startShadow("/r/packages/b", {}, second.deps).finish(RESULTS);

		expect(second.predictions).toBe(0);
		expect(second.reconciled).toHaveLength(1);
	});

	// An outcome is read by the other test processes of the same run and by
	// nobody after that, so it has no reason to outlive the run by a day.
	it("clears out an outcome once no process of its run could still read it", async () => {
		const root = tempRoot();
		const pending = path.join(root, ".variant/history/pending");
		mkdirSync(pending, { recursive: true });
		const finished = path.join(pending, `${"c".repeat(40)}.json`);
		const recent = path.join(pending, `${"d".repeat(40)}.json`);
		writeFileSync(finished, "{}");
		writeFileSync(recent, "{}");
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
		utimesSync(finished, twoHoursAgo, twoHoursAgo);
		utimesSync(recent, fiveMinutesAgo, fiveMinutesAgo);

		await startShadow("/r", {}, harness(root).deps).finish(RESULTS);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(existsSync(finished)).toBe(false);
		expect(existsSync(recent)).toBe(true);
	});

	it("clears out outcomes left by runs long past", async () => {
		const root = tempRoot();
		const pending = path.join(root, ".variant/history/pending");
		mkdirSync(pending, { recursive: true });
		const old = path.join(pending, `${"b".repeat(40)}.json`);
		writeFileSync(old, "{}");
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
		utimesSync(old, twoDaysAgo, twoDaysAgo);

		await startShadow("/r", {}, harness(root).deps).finish(RESULTS);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(existsSync(old)).toBe(false);
	});

	it("predicts again locally, where the tree can change under one commit", async () => {
		const root = tempRoot();
		const env = { CI: "", VARIANT_SHADOW: "1" };
		const first = harness(root, { env });
		const second = harness(root, { env });

		await startShadow("/r", {}, first.deps).finish(RESULTS);
		await startShadow("/r", {}, second.deps).finish(RESULTS);

		expect(second.predictions).toBe(1);
	});
});
