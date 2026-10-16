/**
 * @module
 * Which changed files `variant check` mutates, and why each other one is
 * left out. Pure: the git reads happen in `run.ts`.
 */

import type { FileHunks, LineRange } from "./hunks.js";

export type ExclusionReason =
	| "test"
	| "declaration"
	| "not-typescript"
	| "outside"
	| "deleted-lines-only"
	| "formatting-only";

export interface Exclusion {
	file: string;
	reason: ExclusionReason;
}

export interface CheckTarget {
	file: string;
	ranges: LineRange[];
	/** A new file git does not track yet, mutated as a whole. */
	untracked: boolean;
}

export interface TargetInput {
	/** Changed tracked files, relative to cwd (`../…` when outside it). */
	changed: readonly string[];
	/** New files under cwd that git neither tracks nor ignores. */
	untracked: readonly string[];
	/** Hunks of each file that was diffed; for a new file, all of it. */
	hunks: ReadonlyMap<string, FileHunks>;
	/** Files whose change is only formatting or comments. */
	formattingOnly: ReadonlySet<string>;
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
/** Installed packages: untracked in a project without a .gitignore, never source. */
const INSTALLED = /(^|\/)node_modules\//;

/** Why a file is not mutated, before any diff is read. */
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

/** New files worth reading: TypeScript someone wrote, not installed packages. */
export function isNewSource(file: string): boolean {
	return (
		TYPESCRIPT.test(file) && !DECLARATION.test(file) && !INSTALLED.test(file)
	);
}

export function selectTargets(input: TargetInput): Targets {
	const targets: CheckTarget[] = [];
	const excluded: Exclusion[] = [];
	let deletedLines = 0;

	const consider = (file: string, untracked: boolean): void => {
		const reason = exclusionBeforeDiff(file, input.isTestFile);
		if (reason !== null) {
			excluded.push({ file, reason });
			return;
		}
		const hunks = input.hunks.get(file);
		if (hunks === undefined || hunks.added.length === 0) {
			excluded.push({ file, reason: "deleted-lines-only" });
			return;
		}
		if (input.formattingOnly.has(file)) {
			excluded.push({ file, reason: "formatting-only" });
			return;
		}
		deletedLines += hunks.deletedLines;
		targets.push({ file, ranges: hunks.added, untracked });
	};

	for (const file of [...input.changed].sort()) consider(file, false);
	// Only TypeScript is worth listing: a new image or lockfile is no news.
	for (const file of [...input.untracked].sort()) {
		if (isNewSource(file)) consider(file, true);
	}
	return { targets, excluded, deletedLines };
}

/** Stryker's `mutate` entries: `path:start-end`, one per changed range. */
export function mutateEntries(targets: readonly CheckTarget[]): string[] {
	return targets.flatMap((target) =>
		target.ranges.map((range) => `${target.file}:${range.start}-${range.end}`),
	);
}
