/**
 * @module
 * The execution path `build`, `dev` and `run` share: attach the live progress
 * renderer to the runner, execute the target, and tear the live block down
 * even when a task throws — a failed run must never leave a dangling spinner.
 */

import { readCache } from "../core/cache/store.js";
import type { RunOptions, TaskRunResult } from "../core/execution/runner.js";
import { runTasksWithDeps } from "../core/execution/runner.js";
import { computeInsights } from "../core/insight/analyzer.js";
import type { VariantContext } from "../types/index.js";
import { renderInsights } from "./render/insight.js";
import { createTaskEventProgress } from "./visuals/task-events.js";

export async function executeTarget(
	target: string,
	ctx: VariantContext,
	runOptions: RunOptions,
	message: string,
): Promise<TaskRunResult[]> {
	const progress = createTaskEventProgress(message);
	runOptions.onTaskEvent = progress.onTaskEvent;
	if (progress.onTaskOutput !== undefined) {
		runOptions.onTaskOutput = progress.onTaskOutput;
	}

	try {
		return await runTasksWithDeps(target, ctx.graph, runOptions);
	} finally {
		progress.finish();
	}
}

/** The post-run summary table: timings and cache hit rate. */
export async function reportRunInsights(
	ctx: VariantContext,
	results: TaskRunResult[],
): Promise<void> {
	const cache = await readCache(ctx.cacheDir);
	renderInsights(computeInsights(results, cache));
}
