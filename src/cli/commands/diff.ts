import {
	classifyFileAgainstRef,
	DEFAULT_DIFF_BASE_REF,
	toWorkspaceRelative,
} from "../../core/semantic/file-change.js";
import { assertBaseRef } from "../../core/vcs/base-ref.js";
import { renderClassification } from "../render/diff.js";

export interface DiffActionOptions {
	/** Git ref to compare against. Defaults to HEAD~1. */
	base?: string;
}

export async function registerDiffAction(
	filePath: string,
	opts: DiffActionOptions = {},
): Promise<void> {
	const cwd = process.cwd();
	const baseRef = opts.base ?? DEFAULT_DIFF_BASE_REF;
	const relPath = toWorkspaceRelative(cwd, filePath);
	await assertBaseRef(cwd, baseRef);
	renderClassification(
		await classifyFileAgainstRef(cwd, relPath, baseRef),
		baseRef,
	);
}
