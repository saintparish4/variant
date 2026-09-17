/**
 * @module
 * `variant pr replay` — intersect the files a PR changes with a recorded
 * trace session, answering "which routes did this branch actually touch?".
 */

import path from "node:path";
import { changedFilesToPackages } from "../cache/git-diff.js";
import { loadPackageGraph } from "../graph/package-graph.js";
import { loadTrace } from "../scope/trace-loader.js";
import { listChangedFilesSinceMergeBase } from "../vcs/git.js";
import { DEFAULT_PR_BASE_REF } from "./check.js";

export const DEFAULT_TRACE_SESSION = "last";

export interface PrReplayOptions {
	base?: string;
	session?: string;
	/** DI for tests: skip git and use these workspace-relative paths. */
	changedFiles?: string[];
}

export interface PrReplayResult {
	baseRef: string;
	sessionId: string;
	framework: string;
	changedFiles: string[];
	touchedModules: string[];
	touchedRoutes: Array<{ path: string; modules: string[] }>;
	touchedPackages: string[];
}

/** Returns null when no trace session is available to replay against. */
export async function runPrReplay(
	cwd: string,
	options: PrReplayOptions = {},
): Promise<PrReplayResult | null> {
	const baseRef = options.base ?? DEFAULT_PR_BASE_REF;
	const session = options.session ?? DEFAULT_TRACE_SESSION;

	const trace = await loadTrace(cwd, session).catch(() => null);
	if (trace === null) return null;

	const changedFiles =
		options.changedFiles ??
		(await listChangedFilesSinceMergeBase(cwd, baseRef)) ??
		[];

	// Traces record absolute module paths; the diff is workspace-relative.
	const changedAbsolute = new Set(
		changedFiles.map((file) => path.resolve(cwd, file)),
	);
	const touchedModules = trace.modules
		.map((module) => module.file)
		.filter((file) => changedAbsolute.has(file));

	const touchedModuleSet = new Set(touchedModules);
	const touchedRoutes = trace.routes.filter((route) =>
		route.modules.some((module) => touchedModuleSet.has(module)),
	);

	const packageGraph = await loadPackageGraph(cwd).catch(() => null);
	const touchedPackages =
		packageGraph === null
			? []
			: [...changedFilesToPackages(changedFiles, packageGraph, cwd)];

	return {
		baseRef,
		sessionId: trace.sessionId,
		framework: trace.framework,
		changedFiles,
		touchedModules,
		touchedRoutes,
		touchedPackages,
	};
}
