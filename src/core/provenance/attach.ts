/**
 * @module
 * Binds a task's provenance to the error that ended it, so the CLI reads one
 * object instead of re-correlating a failure against a separate lookup.
 */

import type { TaskProvenance } from "../../types/index.js";
import { TaskExecutionError, VariantError } from "../errors.js";

/**
 * Returns the error to throw for a failed task, carrying that task's
 * provenance when the run has any.
 *
 * A throwable that is not already a `VariantError` gets wrapped: a task's command
 * failing is a task failure, not an internal bug, and the CLI top level maps
 * those to different exit codes. `executeTask` always throws
 * `TaskExecutionError`, so in practice only an injected executor takes this
 * branch.
 */
export function attachProvenance(
	err: unknown,
	taskId: string,
	provenance: Map<string, TaskProvenance> | undefined,
): VariantError {
	const failure =
		err instanceof VariantError
			? err
			: new TaskExecutionError(
					taskId,
					1,
					`Task "${taskId}" failed: ${String(err)}`,
					{ cause: err },
				);

	const entry = provenance?.get(taskId);
	if (entry !== undefined) failure.provenance = entry;
	return failure;
}
