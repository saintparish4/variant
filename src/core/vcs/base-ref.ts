/**
 * @module
 * The base ref of a change analysis must name a commit.
 *
 * `vcs/git.ts` answers null for any git failure, which suits the task cache:
 * a missing diff only costs an optimization there. For change analysis the
 * same null reads as "nothing changed", so a mistyped or unfetched ref once
 * produced "safe to skip build". Resolving the ref first makes that an error,
 * which is the wide answer.
 */

import { GitRefError } from "../errors.js";
import { resolveCommit } from "./git.js";

export async function assertBaseRef(cwd: string, ref: string): Promise<void> {
	if ((await resolveCommit(cwd, ref)) === null) {
		throw new GitRefError(`"${ref}" does not name a commit in this repository`);
	}
}
