/**
 * @module
 * Bridges the pure signature differ to the working tree: fetch a file's two
 * versions (base ref and on disk) and classify the change. `pr check` and
 * `diff` both go through here so they can never disagree about what "before"
 * and "after" mean.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { CliUsageError } from "../errors.js";
import { readFileAtRef } from "../vcs/git.js";
import type { ClassifyResult } from "./differ.js";
import { classifyChange } from "./differ.js";

export const DEFAULT_DIFF_BASE_REF = "HEAD~1";

/**
 * Workspace-relative, POSIX-separated — the form git pathspecs require. A path
 * outside the workspace is an error: git finds nothing at `../x.ts`, and an
 * empty base reads as a new file, which classifies every export as added.
 */
export function toWorkspaceRelative(cwd: string, filePath: string): string {
	const relative = path.relative(cwd, path.resolve(cwd, filePath));
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new CliUsageError(`${filePath} is outside the repository at ${cwd}`);
	}
	return relative.replace(/\\/g, "/");
}

/**
 * A missing side is meaningful rather than an error: no `before` means the
 * file is new, no `after` means it was deleted. Both classify against "".
 */
export async function classifyFileAgainstRef(
	cwd: string,
	relPath: string,
	baseRef: string,
): Promise<ClassifyResult> {
	const [before, after] = await Promise.all([
		readFileAtRef(cwd, baseRef, relPath),
		readFile(path.resolve(cwd, relPath), "utf8").catch(() => null),
	]);
	return classifyChange({
		filePath: relPath,
		before: before ?? "",
		after: after ?? "",
	});
}
