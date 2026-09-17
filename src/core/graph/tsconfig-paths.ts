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

import { access } from "node:fs/promises";
import path from "node:path";

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
			aliases.push({ prefix, suffix, wildcard, targets });
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
 * Read the workspace tsconfig's `paths`. Returns [] when there is no tsconfig,
 * no `paths`, or the file cannot be parsed — a resolver that throws on a
 * malformed config would fail the whole command over an optional optimization.
 */
export async function readPathAliases(
	cwd: string,
	tsconfigName = "tsconfig.json",
): Promise<PathAlias[]> {
	const configPath = path.join(cwd, tsconfigName);

	// Cheap existence check first. ts-morph is ~50MB, and a repository with no
	// tsconfig has no aliases to find — paying the load to learn that is the
	// most common case in a single-package project.
	try {
		await access(configPath);
	} catch {
		return [];
	}

	const { ts } = await import("ts-morph");

	const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
	if (read.error !== undefined || read.config === undefined) return [];

	// parseJsonConfigFileContent follows `extends` and applies `baseUrl`, which
	// is the whole reason for going through the compiler here.
	const parsed = ts.parseJsonConfigFileContent(
		read.config,
		{
			...ts.sys,
			// Enumerating every file in the workspace is pure waste: only
			// `compilerOptions` is wanted, and a large repo makes this the most
			// expensive call in the command.
			readDirectory: () => [],
			useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		},
		cwd,
	);

	return toPathAliases(cwd, parsed.options.paths, parsed.options.baseUrl);
}
