/**
 * @module
 * Workspace package discovery + package-level DAG. Reads pnpm-workspace.yaml,
 * else package.json `workspaces`, else the `packages/*`, `apps/*` and
 * `services/*` fallback; produces a deterministic list of WorkspacePackages
 * and a coarse package-level DAG that drives auto-generated TaskGraph entries.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TaskConfig } from "../../types/index.js";

export interface WorkspacePackage {
	name: string;
	/** Absolute path to the package directory */
	dir: string;
	/** Parsed package.json contents  (subset we care about) */
	manifest: {
		name: string;
		version?: string;
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
		/**
		 * Kept unparsed: the shape is a recursive union of strings, arrays and
		 * condition objects, and `core/graph/package-exports.ts` is the one
		 * place that interprets it.
		 */
		exports?: unknown;
	};
}

export interface PackageGraph {
	packages: ReadonlyArray<WorkspacePackage>;
	/** package name -> set of workspace package names it depends on */
	edges: ReadonlyMap<string, ReadonlySet<string>>;
}

const WORKSPACE_GLOBS_FALLBACK = ["packages/*", "apps/*", "services/*"];

export async function loadPackageGraph(cwd: string): Promise<PackageGraph> {
	// Lazy, for the same reason symbol-graph.ts loads it lazily: this module is
	// on the static import path of cli/context.ts, so a static fast-glob costs
	// every command ~25 ms — including the ones that never scan a workspace.
	const fg = (await import("fast-glob")).default;
	const globs = await readWorkspaceGlobs(cwd);
	const dirs = await fg(globs, {
		cwd,
		onlyDirectories: true,
		absolute: true,
	});

	// Manifest reads are independent, and this runs inside createContext() on
	// every command — reading them serially made startup an O(packages)
	// latency chain. Mapping over the sorted array keeps the order stable.
	const packages = (await Promise.all(dirs.sort().map(readPackage))).filter(
		(pkg): pkg is WorkspacePackage => pkg !== null,
	);

	const byName = new Map(packages.map((p) => [p.manifest.name, p]));
	const edges = new Map<string, Set<string>>();
	for (const p of packages) {
		const set = new Set<string>();
		const all = {
			...(p.manifest.dependencies ?? {}),
			...(p.manifest.devDependencies ?? {}),
			...(p.manifest.peerDependencies ?? {}),
		};
		for (const dep of Object.keys(all)) {
			if (byName.has(dep)) set.add(dep);
		}
		edges.set(p.manifest.name, set);
	}

	return { packages, edges };
}

/**
 * Directory → owning package, built once per graph.
 *
 * Keyed on graph identity because a PackageGraph is immutable once built, and
 * held weakly so a graph going out of scope takes its index with it. The
 * callers (`changedFilesToPackages`, the trace loaders) all resolve every file
 * in a diff or trace, which made the previous linear scan O(files × packages).
 */
const ownersByGraph = new WeakMap<
	PackageGraph,
	Map<string, WorkspacePackage>
>();

function ownersOf(graph: PackageGraph): Map<string, WorkspacePackage> {
	let owners = ownersByGraph.get(graph);
	if (owners === undefined) {
		owners = new Map();
		// path.resolve normalizes separators, which matters because package
		// dirs come from fast-glob (POSIX on every host) while the paths looked
		// up come from git or path.join (native).
		for (const pkg of graph.packages) {
			const dir = path.resolve(pkg.dir);
			// Two packages claiming one directory is malformed input; the first
			// listed wins so the attribution stays deterministic.
			if (!owners.has(dir)) owners.set(dir, pkg);
		}
		ownersByGraph.set(graph, owners);
	}
	return owners;
}

/**
 * The workspace package owning `filePath`, or null if none does.
 *
 * Walks the path's own directories upward, so the cost is bounded by path
 * depth rather than package count, and the innermost package wins — a file in
 * a package nested inside another belongs to the nested one.
 */
export function packageForFile(
	filePath: string,
	graph: PackageGraph,
): WorkspacePackage | null {
	const owners = ownersOf(graph);
	if (owners.size === 0) return null;

	let current = path.resolve(filePath);
	while (true) {
		const owner = owners.get(current);
		if (owner !== undefined) return owner;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Auto-generate TaskConfig entries from package scripts. Naming convention:
 *   <package-name>:<script-name>
 * Existing user-defined tasks always win; we only fill gaps.
 */

export function tasksFromPackageGraph(
	graph: PackageGraph,
	existing: Record<string, TaskConfig>,
	scripts: ReadonlyArray<string> = ["build", "test", "lint"],
	pm = "pnpm",
): Record<string, TaskConfig> {
	const out: Record<string, TaskConfig> = { ...existing };
	for (const pkg of graph.packages) {
		const pkgScripts = pkg.manifest.scripts ?? {};
		for (const script of scripts) {
			if (!pkgScripts[script]) continue;
			const taskName = `${pkg.manifest.name}:${script}`;
			if (out[taskName]) continue;
			const dependsOn: string[] = [];
			for (const upstream of graph.edges.get(pkg.manifest.name) ?? []) {
				if ((scripts as readonly string[]).includes(script)) {
					dependsOn.push(`${upstream}:${script}`);
				}
			}
			out[taskName] = {
				command: `${pm} --filter ${pkg.manifest.name} run ${script}`,
				dependsOn,
				inputs: [
					path.posix.join(
						path.relative(process.cwd(), pkg.dir).replace(/\\/g, "/"),
						"**/*.{ts,tsx,js,jsx,json}",
					),
				],
			};
		}
	}

	// Wire each top-level script meta-task to depend on all its workspace tasks
	// so `variant build` runs all `*:build` tasks in dependency order.
	for (const script of scripts) {
		const workspaceTasks = Object.keys(out).filter(
			(name) => name.endsWith(`:${script}`) && !existing[name],
		);
		if (workspaceTasks.length > 0 && out[script] !== undefined) {
			const existingDeps = out[script].dependsOn ?? [];
			const newDeps = workspaceTasks.filter((t) => !existingDeps.includes(t));
			out[script] = {
				...out[script],
				dependsOn: [...existingDeps, ...newDeps],
			};
		}
	}

	return out;
}

/**
 * BFS over the reverse dependency graph: returns every package that is
 * directly changed OR transitively depends on a changed package.
 *
 * Example: utils changes → web (depends on utils) is also affected.
 */
export function computeAffectedPackages(
	changed: ReadonlySet<string>,
	graph: PackageGraph,
): Set<string> {
	// Build reverse edges: dep -> packages that declare it as a dependency
	const rdeps = new Map<string, Set<string>>();
	for (const [name, deps] of graph.edges) {
		for (const dep of deps) {
			let s = rdeps.get(dep);
			if (!s) {
				s = new Set();
				rdeps.set(dep, s);
			}
			s.add(name);
		}
	}

	const affected = new Set<string>(changed);
	// Frontier BFS: each wave expands to packages that depend on the previous wave.
	let frontier = new Set<string>(changed);
	while (frontier.size > 0) {
		const next = new Set<string>();
		for (const pkg of frontier) {
			for (const dependent of rdeps.get(pkg) ?? []) {
				if (!affected.has(dependent)) {
					affected.add(dependent);
					next.add(dependent);
				}
			}
		}
		frontier = next;
	}
	return affected;
}

async function readWorkspaceGlobs(cwd: string): Promise<string[]> {
	const pnpm = path.join(cwd, "pnpm-workspace.yaml");
	if (await fileExists(pnpm)) {
		const text = await readFile(pnpm, "utf8");
		const lines = text.split("\n");
		const globs: string[] = [];
		let inPackages = false;
		for (const line of lines) {
			const t = line.trim();
			if (t.startsWith("packages:")) {
				inPackages = true;
				continue;
			}
			if (inPackages) {
				const m = /^-\s*['"]?([^'"\s]+)['"]?/.exec(t);
				const glob = m?.[1];
				if (glob !== undefined) globs.push(glob);
				else if (t && !t.startsWith("#")) inPackages = false;
			}
		}
		if (globs.length) return globs;
	}
	const root = path.join(cwd, "package.json");
	if (await fileExists(root)) {
		const json = JSON.parse(await readFile(root, "utf8")) as {
			workspaces?: string[] | { packages?: string[] };
		};
		const ws = Array.isArray(json.workspaces)
			? json.workspaces
			: json.workspaces?.packages;
		if (ws?.length) return ws;
	}
	return WORKSPACE_GLOBS_FALLBACK;
}

async function readPackage(dir: string): Promise<WorkspacePackage | null> {
	const manifestPath = path.join(dir, "package.json");
	try {
		// No stat first: a missing manifest throws ENOENT here anyway, and the
		// extra syscall was paid once per candidate directory.
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		if (!manifest?.name) return null;
		return { name: manifest.name, dir, manifest };
	} catch {
		return null;
	}
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}
