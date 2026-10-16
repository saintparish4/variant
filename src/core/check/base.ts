/**
 * @module
 * What `variant check` compares the working tree against.
 *
 * Before committing, the change is what is not committed yet, so a dirty
 * tree is measured against HEAD. A clean branch is measured from where it
 * left the default branch. In CI the environment names the base, and wins
 * even over a tree that a codegen step has dirtied.
 */

import { NoChangeBaseError } from "../errors.js";
import type { ChangeBaseDeps } from "../vcs/change-base.js";
import { resolveChangeBase } from "../vcs/change-base.js";

export interface CheckBase {
	ref: string;
	/** What `ref` stands for, in words. */
	label: string;
}

export interface CheckBaseDeps extends ChangeBaseDeps {
	/** Whether a tracked file differs from HEAD; null when git cannot say. */
	hasTrackedChanges: () => Promise<boolean | null>;
}

/** Sources that name the base outright, whatever the tree looks like. */
const NAMED = new Set(["flag", "environment", "pull-request", "push"]);

export async function resolveCheckBase(
	explicit: string | undefined,
	deps: CheckBaseDeps,
): Promise<CheckBase> {
	const detected = await resolveChangeBase(explicit, deps);
	if (NAMED.has(detected.source)) {
		return { ref: detected.ref, label: detected.label };
	}
	if ((await deps.hasTrackedChanges()) === true) {
		return { ref: "HEAD", label: "HEAD: your staged and unstaged changes" };
	}
	if (detected.source === "default-branch") {
		return { ref: detected.ref, label: detected.label };
	}
	throw new NoChangeBaseError(
		"Nothing to compare against: the working tree is clean and this branch has not left the default branch",
	);
}
