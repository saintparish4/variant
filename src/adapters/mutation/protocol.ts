/**
 * @module
 * What the Stryker host process and `variant check` say to each other over
 * IPC. Shapes stay close to Stryker's own; `stryker.ts` turns them into the
 * core port's.
 */

export interface HostRequest {
	mutate: string[];
	vitestConfig?: string;
	baselineTimeoutMinutes: number;
	/** Where Stryker puts its sandboxes, relative to cwd. */
	tempDirName: string;
	/** An empty config, so a Stryker config in the project is never merged in. */
	configFile: string;
	/** Absolute path of the reporter plugin module. */
	reporter: string;
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
}

export type HostMessage =
	| { kind: "baseline"; tests: RawTest[] }
	| { kind: "plan"; mutants: RawPlannedMutant[] }
	| { kind: "tested"; mutant: RawTestedMutant }
	| { kind: "finished" }
	| { kind: "note"; text: string }
	| { kind: "baseline-failed" }
	| { kind: "error"; message: string };

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
