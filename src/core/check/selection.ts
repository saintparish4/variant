/**
 * @module
 * Which planned mutants count toward `--max-mutants`.
 *
 * The first N the engine will run, in plan order, which is the order it runs
 * them in. Taking the first N that happen to finish would give a different
 * set on every run once more than one worker is busy, and the same change
 * should read the same twice.
 */

import type { PlannedMutant } from "./backend.js";

export interface Selection {
	/** Run against tests; at most the limit. */
	selected: Set<string>;
	/**
	 * Code no test executed: the engine reports these without running a
	 * test, so they cost nothing and are never left out.
	 */
	free: Set<string>;
	/** Planned but past the limit, so never run. */
	overLimit: string[];
}

export function selectMutants(
	plan: readonly PlannedMutant[],
	maxMutants: number,
): Selection {
	const selected = new Set<string>();
	const free = new Set<string>();
	const overLimit: string[] = [];
	for (const mutant of plan) {
		if (!mutant.covered && !mutant.static) {
			free.add(mutant.id);
		} else if (selected.size < maxMutants) {
			selected.add(mutant.id);
		} else {
			overLimit.push(mutant.id);
		}
	}
	return { selected, free, overLimit };
}
