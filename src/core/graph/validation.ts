/**
 * @module
 * The checks behind `variant check`: every dependency resolves, and every
 * task has a cycle-free path to its dependencies.
 */

import type { TaskConfig, TaskGraph } from "../../types/index.js";
import { ConfigError } from "../errors.js";

/**
 * Throws {@link ConfigError} for a `dependsOn` entry naming a task that does
 * not exist, and {@link CycleError} (from `toLevels`) for a circular
 * dependency. Resolving every task — not just the requested target — is the
 * point: `check` is a pre-flight gate, so a cycle in an unrelated branch of
 * the graph should fail here rather than at the run that first touches it.
 */
export function validateTaskGraph(
	tasks: Record<string, TaskConfig>,
	graph: TaskGraph,
): void {
	for (const [name, task] of Object.entries(tasks)) {
		for (const dependency of task.dependsOn ?? []) {
			if (!(dependency in tasks)) {
				throw new ConfigError(
					`Task "${name}" depends on unknown task "${dependency}"`,
				);
			}
		}
	}

	for (const name of Object.keys(tasks)) {
		graph.toLevels(name);
	}
}
