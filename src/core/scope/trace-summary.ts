/**
 * @module
 * Reduces a recorded trace session to the numbers `variant trace analyze`
 * reports. Pure given a loaded trace and package graph — the reading happens
 * in `trace-loader`, the rendering in `cli/render`.
 */

import type { TraceFile } from "../../tracer/types.js";
import type { PackageGraph } from "../graph/package-graph.js";
import { packageForFile } from "../graph/package-graph.js";

export interface PackageModuleCount {
	name: string;
	modules: number;
}

export interface TraceSummary {
	sessionId: string;
	framework: string;
	startedAt: number;
	durationMs: number;
	moduleCount: number;
	routes: Array<{ path: string; moduleCount: number }>;
	packagesTouched: number;
	/** Descending by module count — the busiest packages read first. */
	modulesByPackage: PackageModuleCount[];
}

export function summarizeTrace(
	trace: TraceFile,
	packageGraph: PackageGraph,
): TraceSummary {
	const counts = new Map<string, number>();
	for (const module of trace.modules) {
		const owner = packageForFile(module.file, packageGraph);
		if (owner !== null) {
			counts.set(owner.name, (counts.get(owner.name) ?? 0) + 1);
		}
	}

	return {
		sessionId: trace.sessionId,
		framework: trace.framework,
		startedAt: trace.startedAt,
		durationMs: trace.endedAt - trace.startedAt,
		moduleCount: trace.modules.length,
		routes: trace.routes.map((route) => ({
			path: route.path,
			moduleCount: route.modules.length,
		})),
		packagesTouched: counts.size,
		modulesByPackage: [...counts.entries()]
			.map(([name, modules]) => ({ name, modules }))
			.sort((a, b) => b.modules - a.modules),
	};
}
