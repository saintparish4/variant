/**
 * @module
 * Gathers everything `checkWorkspace` needs from disk — the package graph,
 * each manifest's declared dependencies, the root manifest, and a fresh symbol
 * graph — and runs the audit. `workspace-check.ts` stays pure; this is the
 * layer that touches the filesystem.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { updateSymbolGraph } from "../semantic/symbol-graph.js";
import { loadPackageGraph } from "./package-graph.js";
import { readPathAliases } from "./tsconfig-paths.js";
import type {
	PackageManifest,
	WorkspaceCheckResult,
} from "./workspace-check.js";
import { checkWorkspace } from "./workspace-check.js";

interface DependencyManifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

/**
 * All three dependency kinds count as "declared": a build-time-only import is
 * satisfied by a devDependency, and a peerDependency is satisfied by the
 * consumer.
 */
function declaredNames(manifest: DependencyManifest): Set<string> {
	return new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);
}

async function readRootDeclared(cwd: string): Promise<Set<string>> {
	try {
		const manifest = JSON.parse(
			await readFile(path.join(cwd, "package.json"), "utf8"),
		) as DependencyManifest;
		return declaredNames(manifest);
	} catch {
		return new Set();
	}
}

/**
 * Every `package.json` under `cwd` by workspace-relative POSIX dir ("" for the
 * root), for `workspaceBlindSpots`. Unreadable or unparsable manifests are
 * left out: this only ever adds notes, so a missing entry cannot hide one.
 */
export async function readManifests(
	cwd: string,
): Promise<Map<string, PackageManifest>> {
	const fg = (await import("fast-glob")).default;
	const found = await fg("**/package.json", {
		cwd,
		onlyFiles: true,
		ignore: ["**/node_modules/**", ".git/**", ".variant/**"],
	});
	const entries = await Promise.all(
		found.map(async (rel) => {
			try {
				const manifest = JSON.parse(
					await readFile(path.join(cwd, rel), "utf8"),
				) as PackageManifest;
				const dir = path.posix.dirname(rel.replace(/\\/g, "/"));
				return [dir === "." ? "" : dir, manifest] as const;
			} catch {
				return undefined;
			}
		}),
	);
	return new Map(entries.filter((entry) => entry !== undefined));
}

/** Returns null when the directory is not a workspace (nothing to audit). */
export async function auditWorkspace(
	cwd: string,
): Promise<WorkspaceCheckResult | null> {
	const packageGraph = await loadPackageGraph(cwd).catch(() => null);
	if (packageGraph === null || packageGraph.packages.length === 0) return null;

	const packages = packageGraph.packages.map((pkg) => ({
		name: pkg.manifest.name,
		dir: path.relative(cwd, pkg.dir).replace(/\\/g, "/"),
		declared: declaredNames(pkg.manifest),
	}));

	const [{ graph: symbolGraph }, rootDeclared, pathAliases, manifests] =
		await Promise.all([
			updateSymbolGraph(cwd),
			readRootDeclared(cwd),
			readPathAliases(cwd),
			readManifests(cwd),
		]);

	return checkWorkspace({
		symbolGraph,
		packages,
		rootDeclared,
		pathAliases,
		manifests,
	});
}
