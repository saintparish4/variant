/**
 * @module
 * The outcome of `variant check`, assembled from what the engine reported.
 * Pure. It is the one place that decides whether a run may read as "all
 * detected", so the rules for that live here and nowhere else.
 */

import type {
	BaselineTest,
	PlannedMutant,
	Position,
	TestedMutant,
} from "./backend.js";
import type { CheckBase } from "./base.js";
import { explainSurvivor } from "./explain.js";
import type { LineRange } from "./hunks.js";
import { countLines } from "./hunks.js";
import type { Selection } from "./selection.js";
import type { CheckTarget, Exclusion } from "./targets.js";

export type Outcome =
	| "detected"
	| "undetected"
	| "no-coverage"
	| "timeout"
	| "runtime-error"
	| "compile-error"
	| "ignored"
	| "not-run";

export type StopReason = "limit" | "budget" | "interrupted";

export interface MutantOutcome {
	id: string;
	file: string;
	start: Position;
	end: Position;
	mutator: string;
	original: string;
	replacement: string;
	outcome: Outcome;
	/** For an undetected mutation: what to review. */
	explanation?: string;
	/** Why it is not run, or the engine's reason for an inconclusive one. */
	reason?: string;
	/** The test that noticed it. */
	killedBy?: string;
	/** How many tests ran against it. */
	testsRun?: number;
	/** The function, method or class it is in. */
	symbol?: string;
	/** Runs when its module loads, so every test was run against it. */
	static?: true;
}

export interface AnalyzedFile {
	file: string;
	ranges: LineRange[];
	/** A new file git does not track yet, mutated as a whole. */
	untracked: boolean;
	changedLines: number;
	mutants: number;
	symbols: string[];
}

export interface CheckResult {
	base: CheckBase;
	/**
	 * `incomplete` whenever anything planned was not run, for whatever
	 * reason. `nothing-to-mutate` when no changed line could be targeted.
	 */
	status: "complete" | "incomplete" | "nothing-to-mutate";
	stopReason?: StopReason;
	/** False when the run stopped before the baseline finished. */
	baselineFinished: boolean;
	files: AnalyzedFile[];
	excluded: Exclusion[];
	deletedLines: number;
	baseline?: { tests: number; files: number; skipped: number };
	vitestConfig?: string;
	mutants: MutantOutcome[];
	counts: Record<Outcome, number> & { attempted: number };
	notes: string[];
	durationMs: number;
}

const STATUS_OUTCOME: Readonly<Record<TestedMutant["status"], Outcome>> = {
	Killed: "detected",
	Survived: "undetected",
	NoCoverage: "no-coverage",
	Timeout: "timeout",
	RuntimeError: "runtime-error",
	CompileError: "compile-error",
	Ignored: "ignored",
	Pending: "not-run",
};

/** Text between two 1-based positions, `end` exclusive. */
export function sliceSource(
	content: string,
	start: Position,
	end: Position,
): string {
	const lines = content.split("\n");
	const offset = (position: Position): number => {
		let total = 0;
		for (let line = 1; line < position.line; line++) {
			total += (lines[line - 1]?.length ?? 0) + 1;
		}
		return total + position.column - 1;
	};
	return content.slice(offset(start), offset(end));
}

export interface AssembleInput {
	base: CheckBase;
	targets: readonly CheckTarget[];
	excluded: readonly Exclusion[];
	deletedLines: number;
	baselineTests?: readonly BaselineTest[];
	vitestConfig?: string;
	plan?: readonly PlannedMutant[];
	selection?: Selection;
	tested: ReadonlyMap<string, TestedMutant>;
	stopReason?: StopReason;
	/** File contents as the run started, for quoting what was mutated. */
	snapshot: ReadonlyMap<string, string>;
	symbols?: ReadonlyMap<string, (line: number) => string | undefined>;
	notes?: readonly string[];
	durationMs: number;
}

function outcomeOf(
	mutant: PlannedMutant,
	input: AssembleInput,
): Pick<MutantOutcome, "outcome" | "reason" | "killedBy" | "testsRun"> {
	const counted =
		input.selection === undefined ||
		input.selection.selected.has(mutant.id) ||
		input.selection.free.has(mutant.id);
	const tested = input.tested.get(mutant.id);
	// A result for a mutant past the limit is dropped: which of those finish
	// depends on timing, and the same change should read the same twice.
	if (!counted || tested === undefined) {
		return {
			outcome: "not-run",
			reason: !counted
				? "past --max-mutants"
				: input.stopReason === "budget"
					? "the --budget ran out"
					: input.stopReason === "interrupted"
						? "interrupted"
						: "not reported",
		};
	}
	const outcome = STATUS_OUTCOME[tested.status];
	return {
		outcome,
		...(outcome !== "detected" &&
			outcome !== "undetected" &&
			tested.statusReason !== undefined && {
				reason: tested.statusReason.split("\n")[0] ?? "",
			}),
		...(tested.killedBy[0] !== undefined && { killedBy: tested.killedBy[0] }),
		...(tested.testsCompleted !== undefined && {
			testsRun: tested.testsCompleted,
		}),
	};
}

export function assembleCheckResult(input: AssembleInput): CheckResult {
	const mutants: MutantOutcome[] = (input.plan ?? []).map((mutant) => {
		const original = sliceSource(
			input.snapshot.get(mutant.file) ?? "",
			mutant.start,
			mutant.end,
		);
		const result = outcomeOf(mutant, input);
		const symbol = input.symbols?.get(mutant.file)?.(mutant.start.line);
		return {
			id: mutant.id,
			file: mutant.file,
			start: mutant.start,
			end: mutant.end,
			mutator: mutant.mutator,
			original,
			replacement: mutant.replacement,
			...result,
			...(result.outcome === "undetected" && {
				explanation: explainSurvivor({
					mutator: mutant.mutator,
					original,
					replacement: mutant.replacement,
				}),
			}),
			...(symbol !== undefined && { symbol }),
			...(mutant.static && { static: true as const }),
		};
	});
	mutants.sort(
		(a, b) =>
			a.file.localeCompare(b.file) ||
			a.start.line - b.start.line ||
			a.start.column - b.start.column ||
			a.id.localeCompare(b.id, undefined, { numeric: true }),
	);

	const counts = {
		detected: 0,
		undetected: 0,
		"no-coverage": 0,
		timeout: 0,
		"runtime-error": 0,
		"compile-error": 0,
		ignored: 0,
		"not-run": 0,
		attempted: 0,
	};
	for (const mutant of mutants) {
		counts[mutant.outcome]++;
		if (mutant.outcome !== "not-run" && mutant.outcome !== "ignored") {
			counts.attempted++;
		}
	}

	const files: AnalyzedFile[] = input.targets.map((target) => {
		const lookup = input.symbols?.get(target.file);
		const symbols = new Set<string>();
		if (lookup !== undefined) {
			for (const range of target.ranges) {
				for (let line = range.start; line <= range.end; line++) {
					const symbol = lookup(line);
					if (symbol !== undefined) symbols.add(symbol);
				}
			}
		}
		return {
			file: target.file,
			ranges: target.ranges,
			untracked: target.untracked,
			changedLines: countLines(target.ranges),
			mutants: mutants.filter((mutant) => mutant.file === target.file).length,
			symbols: [...symbols],
		};
	});

	const baselineFinished = input.baselineTests !== undefined;
	const status =
		input.targets.length === 0
			? "nothing-to-mutate"
			: input.plan === undefined ||
					input.stopReason !== undefined ||
					counts["not-run"] > 0
				? "incomplete"
				: "complete";

	return {
		base: input.base,
		status,
		...(input.stopReason !== undefined && { stopReason: input.stopReason }),
		baselineFinished,
		files,
		excluded: [...input.excluded],
		deletedLines: input.deletedLines,
		...(input.baselineTests !== undefined && {
			baseline: {
				tests: input.baselineTests.length,
				files: new Set(input.baselineTests.map((test) => test.file)).size,
				skipped: input.baselineTests.filter((test) => test.skipped).length,
			},
		}),
		...(input.vitestConfig !== undefined && {
			vitestConfig: input.vitestConfig,
		}),
		mutants,
		counts,
		notes: [...(input.notes ?? [])],
		durationMs: input.durationMs,
	};
}

/**
 * Whether every attempted mutation was detected. Only a complete run with at
 * least one attempt, nothing inconclusive and nothing unreached qualifies:
 * anything less is not evidence about these lines.
 */
export function allDetected(result: CheckResult): boolean {
	const { counts } = result;
	return (
		result.status === "complete" &&
		counts.attempted > 0 &&
		counts.detected === counts.attempted
	);
}
