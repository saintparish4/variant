/**
 * @module
 * tsconfig `paths` aliases, flattened into the prefix table the import graph
 * resolves against.
 *
 * Without this, an alias-only edge (`import { x } from "@/lib/x"`) lands in
 * `unresolved`: the change does not propagate to the file's real importers and
 * `impact` under-selects. Under-selection is the dangerous direction — it is
 * what produces a false skip — so closing this gap matters more than the
 * confidence score it also improves.
 *
 * Parsing goes through the TypeScript compiler's own config reader rather than
 * `JSON.parse`. tsconfig is JSONC, `extends` can chain, and `baseUrl` changes
 * what the targets are relative to; reimplementing that is how a resolver
 * quietly disagrees with the compiler it is modelling.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { toImportAliases } from "./package-imports.js";

/** One `paths` entry, pre-split around its single wildcard. */
export interface PathAlias {
	/** Text before the `*`, or the whole pattern for an exact alias. */
	prefix: string;
	/** Text after the `*`. Empty for a prefix-only or exact alias. */
	suffix: string;
	/** True when the pattern contained a `*`. */
	wildcard: boolean;
	/**
	 * Substitution targets as workspace-relative POSIX paths, `*` intact.
	 * Order is significant: TypeScript takes the first that resolves.
	 */
	targets: readonly string[];
	/**
	 * Directory of the tsconfig that declared the alias, workspace-relative
	 * POSIX: the alias applies to files under it. Absent for the workspace's
	 * own tsconfig, which applies to every file.
	 */
	scope?: string;
}

const MAX_WILDCARDS = 1;

/**
 * Flatten `compilerOptions.paths` into match-ready aliases.
 *
 * `paths` and `baseUrl` are taken as the compiler resolved them, so absolute
 * target paths are rebased onto `cwd`. A target outside the workspace is
 * dropped — it can never name an indexed file.
 */
export function toPathAliases(
	cwd: string,
	paths: Record<string, readonly string[]> | undefined,
	baseUrl: string | undefined,
	scope?: string,
): PathAlias[] {
	if (paths === undefined) return [];

	const base = baseUrl ?? cwd;
	const aliases: PathAlias[] = [];

	for (const [pattern, rawTargets] of Object.entries(paths)) {
		// TypeScript rejects more than one `*`; so do we, rather than guess.
		const stars = pattern.split("*").length - 1;
		if (stars > MAX_WILDCARDS) continue;

		const wildcard = stars === 1;
		const [prefix = "", suffix = ""] = wildcard
			? pattern.split("*")
			: [pattern, ""];

		const targets: string[] = [];
		for (const target of rawTargets) {
			if (target.split("*").length - 1 > MAX_WILDCARDS) continue;
			const absolute = path.resolve(base, target);
			const relative = path.relative(cwd, absolute).replace(/\\/g, "/");
			// `..` escapes the workspace; nothing there is indexed.
			if (relative === "" || relative.startsWith("../")) continue;
			targets.push(relative);
		}

		if (targets.length > 0) {
			aliases.push({
				prefix,
				suffix,
				wildcard,
				targets,
				...(scope !== undefined && { scope }),
			});
		}
	}

	// Longest prefix first, mirroring TypeScript's preference for the most
	// specific pattern when several match.
	aliases.sort((a, b) => b.prefix.length - a.prefix.length);
	return aliases;
}

/**
 * Base paths a specifier could name via `paths`, most specific alias first.
 * Extension probing is the caller's job — these are bases, not files.
 */
export function matchPathAlias(
	spec: string,
	aliases: readonly PathAlias[],
): string[] {
	const bases: string[] = [];
	for (const alias of aliases) {
		if (!alias.wildcard) {
			if (spec === alias.prefix) bases.push(...alias.targets);
			continue;
		}
		if (
			spec.length < alias.prefix.length + alias.suffix.length ||
			!spec.startsWith(alias.prefix) ||
			!spec.endsWith(alias.suffix)
		) {
			continue;
		}
		const captured = spec.slice(
			alias.prefix.length,
			spec.length - alias.suffix.length,
		);
		for (const target of alias.targets) {
			bases.push(target.replace("*", captured));
		}
	}
	return bases;
}

/**
 * The aliases in force for `file`: those of the nearest tsconfig first, then
 * each enclosing one out to the workspace's own. The same pattern (`@/*`)
 * usually names a different directory in every package that declares it, so
 * the nearest has to win. An outer alias stays as a fallback: applying one
 * the compiler would not costs a spurious edge, and leaving out one it would
 * costs a missed dependent.
 */
export function aliasesInScope(
	file: string,
	aliases: readonly PathAlias[],
): PathAlias[] {
	// The sort is stable, so each tsconfig's own most-specific-first order holds.
	return aliases
		.filter(
			(alias) =>
				alias.scope === undefined || file.startsWith(`${alias.scope}/`),
		)
		.sort((a, b) => (b.scope?.length ?? -1) - (a.scope?.length ?? -1));
}

const CONFIG_IGNORE = [
	"**/node_modules/**",
	"**/dist/**",
	".git/**",
	".variant/**",
];

/**
 * Every alias the workspace declares: `paths` from each `tsconfig.json` and
 * `imports` from each `package.json`, each scoped to its own directory.
 *
 * Only the `tsconfig.json` in `cwd` used to be read: from a workspace root an
 * app's own `@/*` named nothing, so the edge was missing and a change behind
 * the alias selected no tests.
 *
 * Found by walking rather than through the package graph, so a package that
 * discovery missed still has its aliases read. A config that cannot be parsed
 * contributes nothing; a resolver that throws on a malformed config would fail
 * the whole command over an optional optimization.
 */
export async function readPathAliases(cwd: string): Promise<PathAlias[]> {
	const fg = (await import("fast-glob")).default;
	const found = (
		await fg(["**/tsconfig.json", "**/package.json"], {
			cwd,
			onlyFiles: true,
			ignore: CONFIG_IGNORE,
		})
	)
		.map((file) => file.replace(/\\/g, "/"))
		.sort();
	const named = (name: string): string[] =>
		found.filter((file) => path.posix.basename(file) === name);

	const [fromTsconfig, fromManifests] = await Promise.all([
		tsconfigAliases(cwd, named("tsconfig.json")),
		Promise.all(
			named("package.json").map((file) => manifestImportAliases(cwd, file)),
		),
	]);
	return [...fromTsconfig, ...fromManifests.flat()];
}

/** An unreadable or malformed manifest contributes nothing. */
async function manifestImportAliases(
	cwd: string,
	manifestPath: string,
): Promise<PathAlias[]> {
	try {
		const manifest: unknown = JSON.parse(
			await readFile(path.join(cwd, manifestPath), "utf8"),
		);
		if (typeof manifest !== "object" || manifest === null) return [];
		const dir = path.posix.dirname(manifestPath);
		return toImportAliases(
			dir === "." ? "" : dir,
			(manifest as { imports?: unknown }).imports,
		);
	} catch {
		return [];
	}
}

async function tsconfigAliases(
	cwd: string,
	configs: readonly string[],
): Promise<PathAlias[]> {
	// ts-morph is ~50MB, and a repository with no tsconfig has no aliases to
	// find: paying the load to learn that is the common case in a small project.
	if (configs.length === 0) return [];
	const { ts } = await import("ts-morph");

	const aliases: PathAlias[] = [];
	for (const config of configs) {
		const configPath = path.join(cwd, config);
		const configDir = path.dirname(configPath);
		const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
		if (read.error !== undefined || read.config === undefined) continue;

		// parseJsonConfigFileContent follows `extends` and applies `baseUrl`,
		// which is the whole reason for going through the compiler here.
		const { options } = ts.parseJsonConfigFileContent(
			read.config,
			{
				...ts.sys,
				// Enumerating every file in the workspace is pure waste: only
				// `compilerOptions` is wanted, and a large repo makes this the
				// most expensive call in the command.
				readDirectory: () => [],
				useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
			},
			configDir,
		);

		// Without `baseUrl`, targets are relative to the config that declared
		// `paths`, which under `extends` is not the one being read.
		const pathsBase = options["pathsBasePath"];
		const base =
			options.baseUrl ??
			(typeof pathsBase === "string" ? pathsBase : configDir);
		const scope = path.posix.dirname(config);
		aliases.push(
			...toPathAliases(
				cwd,
				options.paths,
				base,
				scope === "." ? undefined : scope,
			),
		);
	}
	return aliases;
}
