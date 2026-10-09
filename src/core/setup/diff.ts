/**
 * @module
 * A line diff small enough to read in a terminal: what `variant init` shows
 * before it changes a file someone else wrote.
 */

export interface DiffLine {
	kind: "same" | "added" | "removed";
	text: string;
}

/** Lines of context kept around each change. */
const CONTEXT = 2;

/** Longest-common-subsequence diff. The files here are a few dozen lines. */
export function diffLines(before: string, after: string): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			const row = lengths[i];
			if (row === undefined) continue;
			row[j] =
				a[i] === b[j]
					? (lengths[i + 1]?.[j + 1] ?? 0) + 1
					: Math.max(lengths[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
		}
	}

	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] ?? "" });
			i++;
			j++;
		} else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0)) {
			out.push({ kind: "removed", text: a[i] ?? "" });
			i++;
		} else {
			out.push({ kind: "added", text: b[j] ?? "" });
			j++;
		}
	}
	for (; i < a.length; i++) out.push({ kind: "removed", text: a[i] ?? "" });
	for (; j < b.length; j++) out.push({ kind: "added", text: b[j] ?? "" });
	return out;
}

/**
 * The changed lines with a little context, `+` and `-` in the margin, and
 * `…` where unchanged lines were left out.
 */
export function renderDiff(before: string, after: string): string[] {
	const lines = diffLines(before, after);
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((line, index) => {
		if (line.kind === "same") return;
		for (
			let k = Math.max(0, index - CONTEXT);
			k <= Math.min(lines.length - 1, index + CONTEXT);
			k++
		) {
			keep[k] = true;
		}
	});

	const out: string[] = [];
	let skipped = false;
	lines.forEach((line, index) => {
		if (!keep[index]) {
			skipped = true;
			return;
		}
		if (skipped && out.length > 0) out.push("    …");
		skipped = false;
		const margin =
			line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
		out.push(`  ${margin} ${line.text}`);
	});
	return out;
}
