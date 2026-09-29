/**
 * @module
 * The shared vocabulary `pr check` and `impact` report their conclusions in.
 * Both walk a set of classified file changes and reduce it to one
 * recommendation, and they must agree — a change that is "build required" for
 * one command cannot be "safe to skip" for the other.
 */

import type { ImpactClass } from "./blast-radius.js";
import type { SemanticClass } from "./differ.js";

export type BuildVerdict =
	| "safe-to-skip"
	| "build-recommended"
	| "build-required";

export interface VerdictOptions {
	/**
	 * Escalates to `build-required` regardless of classifications — for
	 * signals that live outside the semantic analysis, such as a config-driven
	 * select-all, which is as strong an indicator as a broken API.
	 */
	forceBuild?: boolean;
}

/**
 * `breaking` dominates: one changed public API is enough to require a build.
 * `internal` and `unanalyzed` only recommend one — the first because a
 * body-only change can still alter behavior, the second because a file the
 * analysis could not read is an unknown, and unknowns are never reported as
 * safe.
 */
export function deriveVerdict(
	classifications: readonly (SemanticClass | ImpactClass)[],
	options: VerdictOptions = {},
): BuildVerdict {
	if (options.forceBuild === true) return "build-required";

	let verdict: BuildVerdict = "safe-to-skip";
	for (const classification of classifications) {
		if (classification === "breaking") return "build-required";
		if (classification === "internal" || classification === "unanalyzed") {
			verdict = "build-recommended";
		}
	}
	return verdict;
}

export type Resolution = "high" | "medium" | "low";

/**
 * The coarse reading of a confidence score. The score counts what the analysis
 * could not resolve; it is not a probability, and two decimals invite reading
 * it as one.
 */
export function resolutionOf(confidence: number): Resolution {
	if (confidence >= 0.9) return "high";
	if (confidence >= 0.7) return "medium";
	return "low";
}

const VERDICT_TEXT: Record<BuildVerdict, string> = {
	"safe-to-skip": "safe to skip build",
	"build-recommended": "build recommended",
	"build-required": "build required",
};

/** The human-readable form of a verdict, shared by every renderer. */
export function verdictText(verdict: BuildVerdict): string {
	return VERDICT_TEXT[verdict];
}
