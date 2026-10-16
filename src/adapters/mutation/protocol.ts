/**
 * @module
 * What the Stryker host process and `variant check` say to each other over
 * IPC. Shapes stay close to Stryker's own; `stryker.ts` turns them into the
 * core port's.
 */

import type { CheckRunner } from "../../core/check/runner.js";

export interface HostRequest {
	mutate: string[];
	runner: CheckRunner;
	baselineTimeoutMinutes: number;
	/** Where Stryker puts its sandboxes, relative to cwd. */
	tempDirName: string;
	/** An empty config, so a Stryker config in the project is never merged in. */
	configFile: string;
	/** Absolute paths of variant's plugin modules: the reporter and this runner's. */
	plugins: string[];
}

export interface RawPosition {
	line: number;
	column: number;
}

export interface RawPlannedMutant {
	id: string;
	fileName: string;
	mutatorName: string;
	replacement: string;
	/** 0-based in Stryker's plan event, unlike its results. */
	location: { start: RawPosition; end: RawPosition };
	coveredBy?: string[];
	static?: boolean;
}

export interface RawTestedMutant {
	id: string;
	status: string;
	statusReason?: string;
	killedBy?: string[];
	testsCompleted?: number;
}

export interface RawTest {
	id: string;
	name: string;
	fileName?: string;
	skipped?: boolean;
}

export type HostMessage =
	| { kind: "baseline"; tests: RawTest[] }
	| { kind: "plan"; mutants: RawPlannedMutant[] }
	| { kind: "tested"; mutant: RawTestedMutant }
	| { kind: "finished" }
	| { kind: "note"; text: string }
	| { kind: "baseline-failed" }
	/** A setup check does not run, found before any test ran. */
	| { kind: "unsupported"; reason: string }
	| { kind: "error"; message: string };

/**
 * Begins the error a plugin throws for a setup check does not run. Stryker
 * passes a worker's error on with its message intact, and a worker has no
 * channel of its own to variant.
 */
export const UNSUPPORTED = "variant check cannot run these tests: ";

/**
 * Appended to a test file's name when the runner adds it as a failed test
 * because it did not load. Core's `DID_NOT_LOAD` is the same string; a test
 * keeps them equal, since an adapter imports only types from core.
 */
export const LOAD_FAILURE_SUFFIX = " (did not load)";

/**
 * Stryker's mutator groups `variant check` turns off: everything but
 * comparisons, boolean conditions and arithmetic. The names are matched
 * exactly against `allMutators` in `@stryker-mutator/instrumenter` 10.0.0.
 */
export const EXCLUDED_MUTATORS = [
	"ArrayDeclaration",
	"ArrowFunction",
	"AssignmentOperator",
	"BlockStatement",
	"CallExpression",
	"MethodExpression",
	"ObjectLiteral",
	"OptionalChaining",
	"Regex",
	"StringLiteral",
	"UnaryOperator",
	"UpdateOperator",
];
