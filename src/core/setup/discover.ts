/**
 * @module
 * What `variant init` finds out about a repository before it proposes
 * anything: how it installs, whether it is a workspace, which test runners it
 * uses and where their configs are, and what its CI does today.
 *
 * Read-only. Everything here is a fact about files on disk; deciding what to
 * do with the facts is `plan.ts`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadPackageGraph } from "../graph/package-graph.js";
import { defaultBranchRef } from "../vcs/git.js";
import { runsTests, withFullHistory } from "./workflow.js";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

export interface WorkflowFacts {
	/** Workspace-relative POSIX path. */
	file: string;
	content: string;
	runsTests: boolean;
	/** True when a checkout in it fetches less than the whole history. */
	shallow: boolean;
}

export interface RepositoryFacts {
	/** Null when no lockfile or `packageManager` field says. */
	packageManager: PackageManagerName | null;
	/** Workspace packages found; 0 when the repository is not a workspace. */
	workspacePackages: number;
	taskRunner: "turborepo" | "nx" | null;
	/** Vitest configs the adapter belongs in; see `adapterTargets`. */
	vitestConfigs: string[];
	jestConfigs: string[];
	playwrightConfigs: string[];
	workflows: WorkflowFacts[];
	/** Without the remote prefix: `main`, not `origin/main`. */
	defaultBranch: string | null;
	/** `@blzsky/variant` is a dependency of the root package. */
	installed: boolean;
	ignoresVariantDir: boolean;
	hasManifest: boolean;
}

const LOCKFILES: ReadonlyArray<[string, PackageManagerName]> = [
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["package-lock.json", "npm"],
	["npm-shrinkwrap.json", "npm"],
];

const IGNORE = ["**/node_modules/**", "**/dist/**", ".git/**", ".variant/**"];

async function readText(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

interface RootManifest {
	packageManager?: unknown;
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
}

async function readManifest(cwd: string): Promise<RootManifest | null> {
	const raw = await readText(path.join(cwd, "package.json"));
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as RootManifest)
			: null;
	} catch {
		return null;
	}
}

async function detectPackageManager(
	cwd: string,
	manifest: RootManifest | null,
): Promise<PackageManagerName | null> {
	// The lockfile is what an install actually used. `packageManager` can say
	// one thing while CI installs with another.
	for (const [lockfile, name] of LOCKFILES) {
		if ((await readText(path.join(cwd, lockfile))) !== null) return name;
	}
	const declared = manifest?.packageManager;
	if (typeof declared === "string") {
		const name = declared.split("@")[0];
		if (
			name === "npm" ||
			name === "pnpm" ||
			name === "yarn" ||
			name === "bun"
		) {
			return name;
		}
	}
	return null;
}

/**
 * Where the adapter goes. A root config's reporters cover every project it
 * runs, so it alone is enough. Without one, each workspace package's own
 * config is a separate test process and needs its own line. Configs anywhere
 * else (fixtures, sample projects) are not this repository's test runs.
 */
export function adapterTargets(
	configs: readonly string[],
	packageDirs: readonly string[],
): string[] {
	const root = configs.filter((file) => !file.includes("/"));
	if (root.length > 0) return root;
	const dirs = new Set(packageDirs);
	return configs.filter((file) => dirs.has(path.posix.dirname(file)));
}

export async function discoverRepository(
	cwd: string,
): Promise<RepositoryFacts> {
	const fg = (await import("fast-glob")).default;
	const [manifest, packageGraph, found, gitignore, branch] = await Promise.all([
		readManifest(cwd),
		loadPackageGraph(cwd).catch(() => null),
		fg(
			[
				"**/vitest.config.{ts,mts,cts,js,mjs,cjs}",
				"**/jest.config.{ts,mts,cts,js,mjs,cjs,json}",
				"**/playwright.config.{ts,mts,cts,js,mjs,cjs}",
				".github/workflows/*.{yml,yaml}",
				"turbo.json",
				"nx.json",
			],
			{ cwd, onlyFiles: true, dot: true, ignore: IGNORE },
		),
		readText(path.join(cwd, ".gitignore")),
		defaultBranchRef(cwd),
	]);
	const files = found.map((file) => file.replace(/\\/g, "/")).sort();
	const named = (prefix: string): string[] =>
		files.filter((file) => path.posix.basename(file).startsWith(prefix));

	const packageDirs = (packageGraph?.packages ?? []).map((pkg) =>
		path.relative(cwd, pkg.dir).replace(/\\/g, "/"),
	);

	const workflows = await Promise.all(
		files
			.filter((file) => file.startsWith(".github/workflows/"))
			.map(async (file): Promise<WorkflowFacts> => {
				const content = (await readText(path.join(cwd, file))) ?? "";
				return {
					file,
					content,
					runsTests: runsTests(content),
					shallow: withFullHistory(content) !== null,
				};
			}),
	);

	return {
		packageManager: await detectPackageManager(cwd, manifest),
		workspacePackages: packageDirs.filter((dir) => dir !== "").length,
		taskRunner: files.includes("turbo.json")
			? "turborepo"
			: files.includes("nx.json")
				? "nx"
				: null,
		vitestConfigs: adapterTargets(named("vitest.config."), packageDirs),
		jestConfigs: named("jest.config."),
		playwrightConfigs: named("playwright.config."),
		workflows,
		defaultBranch: branch?.replace(/^origin\//, "") ?? null,
		installed:
			"@blzsky/variant" in (manifest?.devDependencies ?? {}) ||
			"@blzsky/variant" in (manifest?.dependencies ?? {}),
		ignoresVariantDir: (gitignore ?? "")
			.split("\n")
			.some((line) => /^\/?\.variant\/?$/.test(line.trim())),
		hasManifest: manifest !== null,
	};
}
