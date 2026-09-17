import { genericAdapter } from "../adapters/frameworks/generic.js";
import { nextAdapter, nextPlugin } from "../adapters/frameworks/next.js";
import { wrapFrameworkAsPlugin } from "../adapters/frameworks/plugin.js";
import { viteAdapter } from "../adapters/frameworks/vite.js";
import {
	changedFilesToPackages,
	getChangedFiles,
} from "../core/cache/git-diff.js";
import { loadConfig } from "../core/config/loader.js";
import { detectProject } from "../core/detection/project.js";
import type { RunOptions } from "../core/execution/runner.js";
import { priorityFromConfig } from "../core/execution/scheduler.js";
import {
	computeAffectedPackages,
	loadPackageGraph,
	tasksFromPackageGraph,
} from "../core/graph/package-graph.js";
import { buildGraph } from "../core/graph/planner.js";
import { PluginRegistry } from "../core/plugins/registry.js";
import { buildProvenance } from "../core/provenance/capture.js";
import type { VariantContext } from "../types/index.js";
import { reportPluginError } from "./render/plugin-errors.js";

export interface CreateContextOptions {
	/**
	 * Compute the git-diff scoping (`packageScopes`, `affectedPackages`,
	 * `changedFiles`). Default true.
	 *
	 * Commands that never run a task and never render provenance — `env`,
	 * `check`, `insight` — pass false, which drops two git subprocesses from
	 * their startup. Anything consuming `packageScopes`, or rendering why a
	 * task ran, must leave it on.
	 */
	scope?: boolean;
}

const EMPTY_PACKAGE_GRAPH = {
	packages: [] as Array<{
		name: string;
		dir: string;
		manifest: { name: string };
	}>,
	edges: new Map<string, ReadonlySet<string>>(),
};

export async function createContext(
	cwd: string = process.cwd(),
	options: CreateContextOptions = {},
): Promise<VariantContext> {
	// Detect PM/runtime/framework once; reuse throughout context construction.
	const [rawConfig, { pm, runtime, framework }] = await Promise.all([
		loadConfig(cwd),
		detectProject(cwd),
	]);

	const workspaceEnabled = rawConfig.workspace?.enabled === true;
	const scopeEnabled =
		options.scope !== false && rawConfig.git?.enabled !== false;

	// Both are started before either is awaited: the git diff needs only cwd
	// and the base ref, so it has no reason to queue behind the workspace scan.
	// A workspace-enabled load must still surface its failure, while the
	// scoping path treats a missing graph as "no packages" and skips the
	// optimization.
	const packageGraphPromise = workspaceEnabled
		? loadPackageGraph(cwd)
		: scopeEnabled
			? loadPackageGraph(cwd).catch(() => EMPTY_PACKAGE_GRAPH)
			: undefined;
	// Resolved in two steps rather than via getChangedPackages so the file
	// list survives for provenance — that helper discards it internally.
	const changedFilesPromise = scopeEnabled
		? getChangedFiles(
				rawConfig.git?.baseRef === undefined
					? { cwd }
					: { cwd, baseRef: rawConfig.git.baseRef },
			)
		: undefined;

	const [pkgGraph, gitFiles] = await Promise.all([
		packageGraphPromise,
		changedFilesPromise,
	]);

	let config = rawConfig;
	if (workspaceEnabled && pkgGraph !== undefined) {
		config = {
			...config,
			tasks: tasksFromPackageGraph(
				pkgGraph,
				config.tasks,
				config.workspace?.scripts,
				pm.name,
			),
		};
	}

	let packageScopes: string[] | undefined;
	let affectedPackages: ReadonlySet<string> | undefined;
	let changedFiles: string[] | undefined;
	// null/undefined -> git unavailable or scoping skipped; no optimization.
	if (gitFiles != null) {
		changedFiles = gitFiles;
		const graph = pkgGraph ?? EMPTY_PACKAGE_GRAPH;
		const changed = changedFilesToPackages(gitFiles, graph, cwd);
		// empty -> no packages matched (single-pkg repo or no changes yet);
		//          skip filtering to avoid hashing zero files
		if (changed.size > 0) {
			// Cascade: a package is affected if it changed directly OR if any
			// package it depends on changed (transitively).
			const affected = computeAffectedPackages(changed, graph);
			packageScopes = graph.packages
				.filter((p) => affected.has(p.name))
				.map((p) => p.dir);
			affectedPackages = affected;
		}
	}

	const cacheDir = config.cache.directory;

	const plugins = new PluginRegistry(reportPluginError);
	plugins.register(wrapFrameworkAsPlugin(nextAdapter));
	plugins.register(wrapFrameworkAsPlugin(viteAdapter));
	plugins.register(wrapFrameworkAsPlugin(genericAdapter));
	plugins.register(nextPlugin);

	await plugins.runOnDetect({
		cwd,
		pm: pm.name,
		framework: framework?.name ?? null,
		tasks: config.tasks,
	});

	const graph = buildGraph(config);

	const provenance = buildProvenance({
		tasks: config.tasks,
		graph,
		strategy: config.strategy,
		...(changedFiles !== undefined ? { changedFiles } : {}),
		...(affectedPackages !== undefined ? { affectedPackages } : {}),
	});

	return {
		cwd,
		config,
		pm: pm.name,
		runtime: { primary: runtime.name, fallback: "node" },
		framework: framework?.name ?? null,
		graph,
		cacheDir,
		plugins,
		provenance,
		...(packageScopes !== undefined ? { packageScopes } : {}),
		...(affectedPackages !== undefined ? { affectedPackages } : {}),
	};
}

/**
 * Lifts an VariantContext into the flat RunOptions shape that the runner
 * expects. Every CLI command that calls runTasksWithDeps should go through
 * this helper -- it is the single source of truth for context-to-options
 * translation.
 */
export function toRunOptions(
	ctx: VariantContext,
	overrides: { concurrency?: number } = {},
): RunOptions {
	const schedulerEnabled = ctx.config.scheduler?.policy !== undefined;
	const derivedPriorityOf = schedulerEnabled
		? priorityFromConfig(ctx.config, ctx.config.tasks)
		: undefined;
	return {
		cwd: ctx.cwd,
		cacheDir: ctx.cacheDir,
		pm: ctx.pm,
		config: ctx.config,
		tasks: ctx.config.tasks,
		plugins: ctx.plugins,
		provenance: ctx.provenance,
		...(ctx.packageScopes !== undefined
			? { packageScopes: ctx.packageScopes }
			: {}),
		...(schedulerEnabled ? { useScheduler: true } : {}),
		...(derivedPriorityOf !== undefined
			? { priorityOf: derivedPriorityOf }
			: {}),
		...(overrides.concurrency !== undefined
			? { concurrency: overrides.concurrency }
			: {}),
	};
}
