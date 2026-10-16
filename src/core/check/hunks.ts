/**
 * @module
 * Changed line ranges from a zero-context `git diff`.
 */

/** Lines `start` to `end` of the working-tree file, 1-based and inclusive. */
export interface LineRange {
	start: number;
	end: number;
}

export interface FileHunks {
	/** Lines added or rewritten, which are what can be mutated. */
	added: LineRange[];
	/** Lines removed with nothing put in their place. */
	deletedLines: number;
}

// `@@ -<old>[,<count>] +<new>[,<count>] @@`; an omitted count is 1.
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Reads only the hunk headers. The file header is ignored on purpose: its
 * path is quoted or escaped for unusual names, while the caller already knows
 * which file it asked about.
 */
export function parseZeroContextDiff(diff: string): FileHunks {
	const added: LineRange[] = [];
	let deletedLines = 0;
	for (const line of diff.split("\n")) {
		const match = HUNK_HEADER.exec(line);
		if (match === null) continue;
		const oldCount = match[1] === undefined ? 1 : Number(match[1]);
		const start = Number(match[2]);
		const newCount = match[3] === undefined ? 1 : Number(match[3]);
		if (newCount === 0) {
			deletedLines += oldCount;
			continue;
		}
		added.push({ start, end: start + newCount - 1 });
	}
	return { added, deletedLines };
}

export function countLines(ranges: readonly LineRange[]): number {
	return ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
}
