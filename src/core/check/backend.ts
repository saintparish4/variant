/**
 * @module
 * The port `variant check` runs mutations through. Core knows these shapes
 * and nothing about the engine behind them (`adapters/mutation/`).
 */

import type { FailingTest } from "../errors.js";

/** 1-based line and column. */
export interface Position {
	line: number;
	column: number;
}

export interface PlannedMutant {
	/** Stable within a run; joins the plan to the results. */
	id: string;
	/** Relative to cwd, POSIX separators. */
	file: string;
	mutator: string;
	replacement: string;
	start: Position;
	/** Exclusive. */
	end: Position;
	/** Whether any test executed this code in the baseline. */
	covered: boolean;
	/** Run while a module loads, so every test is run against it. */
	static: boolean;
}

export type MutantStatus =
	| "Killed"
	| "Survived"
	| "NoCoverage"
	| "Timeout"
	| "RuntimeError"
	| "CompileError"
	| "Ignored"
	| "Pending";

export interface TestedMutant {
	id: string;
	status: MutantStatus;
	statusReason?: string;
	killedBy: string[];
	/** Tests run against it; absent when the engine did not say. */
	testsCompleted?: number;
}

export interface BaselineTest {
	id: string;
	name: string;
	/** Relative to cwd, POSIX separators. */
	file: string;
	/** Skipped in the baseline (`skip`, `skipIf`), so it noticed nothing. */
	skipped: boolean;
}

export type BackendEvent =
	| { kind: "baseline"; tests: BaselineTest[] }
	| {
			kind: "plan";
			mutants: PlannedMutant[];
			/**
			 * False when the engine had no coverage information: every mutant
			 * then ran against every test, and none can read as unreached.
			 */
			coverageMeasured: boolean;
	  }
	| { kind: "tested"; mutant: TestedMutant }
	| { kind: "finished" }
	/** Something about the run the report should say. */
	| { kind: "note"; text: string }
	| { kind: "baseline-failed"; failingTests: FailingTest[]; output: string }
	| { kind: "error"; message: string; output: string };

export interface BackendRequest {
	cwd: string;
	/** `path:start-end` entries. */
	mutate: string[];
	vitestConfig?: string;
	/** How long the baseline may take before the engine gives up on it. */
	baselineTimeoutMinutes: number;
}

export interface BackendRun {
	events: AsyncIterable<BackendEvent>;
	/** Ends the run, its processes and its files. Resolves once all are gone. */
	stop: () => Promise<void>;
}

export interface MutationBackend {
	start: (request: BackendRequest) => BackendRun;
}
