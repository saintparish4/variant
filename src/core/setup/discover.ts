/**
 * @module
 * What `variant init` finds out about a repository before it proposes
 * anything: how it installs, whether it is a workspace, which test runners it
 * uses and where their configs are, and what its CI does today.
 *
 * Read-only. Everything here is a fact about files on disk; deciding what to
 * do with the facts is `plan.ts`.
 */

import { access, readFile } from "node:fs/promises";
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
	/**
	 * Directories ("" for the root) of packages that depend on Vitest and
	 * have no config of any kind: Vitest runs there on its defaults, and the
	 * adapter needs a config to be in.
	 */
	vitestWithoutConfig: string[];
	/**
	 * Vite configs of packages that depend on Vitest and have no Vitest
	 * config. Vitest reads these, and a new `vitest.config` beside one would
	 * replace it, plugins and aliases included.
	 */
	viteConfigs: string[];
	/** Packages whose scripts pass `--reporter` to Vitest, overriding any config. */
	reporterFlags: string[];
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
	scripts?: Record<string, unknown>;
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

const MANAGERS = new Set<string>(["npm", "pnpm", "yarn", "bun"]);

async function managerIn(dir: string): Promise<PackageManagerName | null> {
	// The lockfile is what an install actually used. `packageManager` can say
	// one thing while CI installs with another.
	for (const [lockfile, name] of LOCKFILES) {
		if ((await readText(path.join(dir, lockfile))) !== null) return name;
	}
	const declared = (await readManifest(dir))?.packageManager;
	const name =
		typeof declared === "string" ? declared.split("@")[0] : undefined;
	return name !== undefined && MANAGERS.has(name)
		? (name as PackageManagerName)
		: null;
}

/**
 * Looks upward from `cwd` to the repository root: a workspace keeps its one
 * lockfile at the top, and a command run from an app's directory is still
 * that workspace's.
 */
async function detectPackageManager(
	cwd: string,
): Promise<PackageManagerName | null> {
	let dir = path.resolve(cwd);
	for (;;) {
		const found = await managerIn(dir);
		if (found !== null) return found;
		const parent = path.dirname(dir);
		// `.git` is a directory in a clone and a file in a worktree.
		const atRoot = await access(path.join(dir, ".git")).then(
			() => true,
			() => false,
		);
		if (parent === dir || atRoot) return null;
		dir = parent;
	}
}

/** The package manager a repository installs with, or null when nothing says. */
export async function packageManagerOf(
	cwd: string,
): Promise<PackageManagerName | null> {
	return detectPackageManager(cwd);
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
				"**/vite.config.{ts,mts,cts,js,mjs,cjs}",
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

	const vitestConfigs = adapterTargets(named("vitest.config."), packageDirs);
	const hasRootConfig = vitestConfigs.some((file) => !file.includes("/"));
	const configDirs = (prefix: string): Map<string, string> =>
		new Map(
			named(prefix).map((file) => {
				const dir = path.posix.dirname(file);
				return [dir === "." ? "" : dir, file];
			}),
		);
	const vitestDirs = configDirs("vitest.config.");
	const viteDirs = configDirs("vite.config.");

	const members: Array<{ dir: string; manifest: RootManifest | null }> = (
		packageGraph?.packages ?? []
	)
		.map((pkg) => ({
			dir: path.relative(cwd, pkg.dir).replace(/\\/g, "/"),
			manifest: pkg.manifest as RootManifest,
		}))
		.filter((member) => member.dir !== "");
	const usesVitest = (candidate: RootManifest | null): boolean =>
		"vitest" in (candidate?.devDependencies ?? {}) ||
		"vitest" in (candidate?.dependencies ?? {});
	// Each package that depends on Vitest runs its own; the root's counts
	// only when no package does.
	const users = members.filter((member) => usesVitest(member.manifest));
	const runners =
		users.length > 0
			? users
			: usesVitest(manifest)
				? [{ dir: "", manifest }]
				: [];
	// A root config's reporters already cover every project it runs.
	const unconfigured = hasRootConfig
		? []
		: runners.filter((runner) => !vitestDirs.has(runner.dir));

	return {
		packageManager: await detectPackageManager(cwd),
		workspacePackages: packageDirs.filter((dir) => dir !== "").length,
		taskRunner: files.includes("turbo.json")
			? "turborepo"
			: files.includes("nx.json")
				? "nx"
				: null,
		vitestConfigs,
		vitestWithoutConfig: unconfigured
			.filter((runner) => !viteDirs.has(runner.dir))
			.map((runner) => runner.dir)
			.sort(),
		viteConfigs: unconfigured
			.flatMap((runner) => viteDirs.get(runner.dir) ?? [])
			.sort(),
		reporterFlags: [{ dir: "", manifest }, ...members]
			.filter((member) =>
				Object.values(member.manifest?.scripts ?? {}).some(
					(script) =>
						typeof script === "string" &&
						/\bvitest\b.*--reporter\b/.test(script),
				),
			)
			.map((member) =>
				member.dir === "" ? "package.json" : `${member.dir}/package.json`,
			)
			.sort(),
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
