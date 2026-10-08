/**
 * @module
 * `variant pr check` — classify every TypeScript file a branch changes
 * relative to its base and reduce them to one build verdict.
 */

import { GitRefError } from "../errors.js";
import type { ClassifyResult } from "../semantic/differ.js";
import { classifyFileAgainstRef } from "../semantic/file-change.js";
import type { BuildVerdict } from "../semantic/verdict.js";
import { deriveVerdict } from "../semantic/verdict.js";
import { assertBaseRef } from "../vcs/base-ref.js";
import { changeBaseDeps, resolvePullRequestBase } from "../vcs/change-base.js";
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

async function listBranchChanges(
	cwd: string,
	baseRef: string,
): Promise<string[]> {
	await assertBaseRef(cwd, baseRef);
	const changed = await listChangedFilesSinceMergeBase(cwd, baseRef);
	// A shallow clone can hold both tips without the commit they share.
	if (changed === null) {
		throw new GitRefError(`"${baseRef}" has no merge base with HEAD`);
	}
	return changed;
}

export async function runPrCheck(
	cwd: string,
	options: PrCheckOptions = {},
): Promise<PrCheckResult> {
	// The target branch in a pull request, the default branch locally. An
	// injected change set has no diff to take, so nothing to detect.
	const baseRef =
		options.changedFiles === undefined
			? await resolvePullRequestBase(options.base, changeBaseDeps(cwd))
			: (options.base ?? DEFAULT_PR_BASE_REF);
	const changed =
		options.changedFiles ?? (await listBranchChanges(cwd, baseRef));
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
