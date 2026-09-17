/**
 * @module
 * `variant pr check` — classify every TypeScript file a branch changes
 * relative to its base and reduce them to one build verdict.
 */

import type { ClassifyResult } from "../semantic/differ.js";
import { classifyFileAgainstRef } from "../semantic/file-change.js";
import type { BuildVerdict } from "../semantic/verdict.js";
import { deriveVerdict } from "../semantic/verdict.js";
import { listChangedFilesSinceMergeBase } from "../vcs/git.js";

export const DEFAULT_PR_BASE_REF = "main";

export interface PrCheckOptions {
	base?: string;
	/** DI for tests: skip git and classify these workspace-relative paths. */
	changedFiles?: string[];
}

export interface PrCheckResult {
	baseRef: string;
	tsFilesChanged: number;
	files: ClassifyResult[];
	verdict: BuildVerdict;
}

const TS_FILE = /\.tsx?$/;

export async function runPrCheck(
	cwd: string,
	options: PrCheckOptions = {},
): Promise<PrCheckResult> {
	const baseRef = options.base ?? DEFAULT_PR_BASE_REF;
	const changed =
		options.changedFiles ??
		(await listChangedFilesSinceMergeBase(cwd, baseRef)) ??
		[];
	const tsFiles = changed.filter((file) => TS_FILE.test(file));

	const files: ClassifyResult[] = [];
	for (const relPath of tsFiles) {
		files.push(await classifyFileAgainstRef(cwd, relPath, baseRef));
	}

	return {
		baseRef,
		tsFilesChanged: tsFiles.length,
		files,
		verdict: deriveVerdict(files.map((file) => file.classification)),
	};
}
