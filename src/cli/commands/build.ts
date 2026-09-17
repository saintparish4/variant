import {
	affectedTaskFilter,
	bothFilters,
} from "../../core/scope/task-filter.js";
import { createContext, toRunOptions } from "../context.js";
import { executeTarget, reportRunInsights } from "../execute.js";
import { renderDryRunPlan } from "../render/plan.js";

export interface BuildActionOptions {
	concurrency?: number;
	/** Only run tasks for packages the current git diff affects (with cascade dependents). */
	affected?: boolean;
	/** Print the task plan without executing anything. */
	dryRun?: boolean;
}

export async function registerBuildAction(
	opts: BuildActionOptions = {},
): Promise<void> {
	const ctx = await createContext();

	if (opts.dryRun) {
		renderDryRunPlan("build", ctx.graph.toLevels("build"));
		return;
	}

	const runOptions = toRunOptions(ctx, opts);

	if (opts.affected && ctx.affectedPackages !== undefined) {
		runOptions.taskFilter = bothFilters(
			runOptions.taskFilter,
			affectedTaskFilter(ctx.affectedPackages),
		);
	}

	const results = await executeTarget(
		"build",
		ctx,
		runOptions,
		"Running build tasks...",
	);
	await reportRunInsights(ctx, results);
}
