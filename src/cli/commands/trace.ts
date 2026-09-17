import { runTasksWithDeps } from "../../core/execution/runner.js";
import type { PackageGraph } from "../../core/graph/package-graph.js";
import { loadPackageGraph } from "../../core/graph/package-graph.js";
import { loadTrace } from "../../core/scope/trace-loader.js";
import { summarizeTrace } from "../../core/scope/trace-summary.js";
import { createContext, toRunOptions } from "../context.js";
import { renderTraceSummary } from "../render/trace.js";

const EMPTY_PACKAGE_GRAPH: PackageGraph = {
	packages: [],
	edges: new Map<string, ReadonlySet<string>>(),
};

export async function registerTraceAction(): Promise<void> {
	const ctx = await createContext();
	// The tracer plugins key off this variable, so it must be set before the
	// dev task spawns its child processes. Progress rendering is deliberately
	// left off here: a traced dev server owns the terminal for its own output.
	process.env["VARIANT_TRACE"] = "1";
	await runTasksWithDeps("dev", ctx.graph, toRunOptions(ctx));
}

export async function registerTraceAnalyzeAction(
	sessionId = "last",
): Promise<void> {
	const ctx = await createContext();
	const [trace, packageGraph] = await Promise.all([
		loadTrace(ctx.cwd, sessionId),
		// A single-package repo has no workspace graph; the per-package
		// breakdown is simply omitted rather than failing the command.
		loadPackageGraph(ctx.cwd).catch(() => EMPTY_PACKAGE_GRAPH),
	]);
	renderTraceSummary(summarizeTrace(trace, packageGraph));
}
