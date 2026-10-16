/**
 * @module
 * Which changed files `variant check` mutates, and why each other one is
 * left out. Pure: the git reads happen in `run.ts`.
 */

import type { FileHunks, LineRange } from "./hunks.js";

export type ExclusionReason =
	| "untracked"
	| "test"
	| "declaration"
	| "not-typescript"
	| "outside"
	| "deleted-lines-only";

export interface Exclusion {
	file: string;
	reason: ExclusionReason;
}

export interface CheckTarget {
	file: string;
	ranges: LineRange[];
}

export interface TargetInput {
	/** Changed tracked files, relative to cwd (`../…` when outside it). */
	changed: readonly string[];
	/** Untracked files under cwd. */
	untracked: readonly string[];
	/** Hunks of each changed TypeScript source file that was diffed. */
	hunks: ReadonlyMap<string, FileHunks>;
	isTestFile: (file: string) => boolean;
}

export interface Targets {
	targets: CheckTarget[];
	excluded: Exclusion[];
	/** Removed lines in mutated files, which no mutation can reach. */
	deletedLines: number;
}

const TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;

/** Why a changed file is not mutated, before any diff is read. */
export function exclusionBeforeDiff(
	file: string,
	isTestFile: (file: string) => boolean,
): ExclusionReason | null {
	if (file.startsWith("../")) return "outside";
	if (!TYPESCRIPT.test(file)) return "not-typescript";
	if (DECLARATION.test(file)) return "declaration";
	if (isTestFile(file)) return "test";
	return null;
}

export function selectTargets(input: TargetInput): Targets {
	const targets: CheckTarget[] = [];
	const excluded: Exclusion[] = [];
	let deletedLines = 0;

	for (const file of [...input.changed].sort()) {
		const reason = exclusionBeforeDiff(file, input.isTestFile);
		if (reason !== null) {
			excluded.push({ file, reason });
			continue;
		}
		const hunks = input.hunks.get(file);
		if (hunks === undefined || hunks.added.length === 0) {
			excluded.push({ file, reason: "deleted-lines-only" });
			continue;
		}
		deletedLines += hunks.deletedLines;
		targets.push({ file, ranges: hunks.added });
	}
	for (const file of [...input.untracked].sort()) {
		if (TYPESCRIPT.test(file) && !DECLARATION.test(file)) {
			excluded.push({ file, reason: "untracked" });
		}
	}
	return { targets, excluded, deletedLines };
}

/** Stryker's `mutate` entries: `path:start-end`, one per changed range. */
export function mutateEntries(targets: readonly CheckTarget[]): string[] {
	return targets.flatMap((target) =>
		target.ranges.map((range) => `${target.file}:${range.start}-${range.end}`),
	);
}
