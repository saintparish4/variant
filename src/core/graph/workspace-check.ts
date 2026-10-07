/**
 * @module
 * Workspace dependency hygiene. Compares what each workspace
 * package actually imports — straight from the SymbolGraph's raw import
 * specifiers — against what its manifest declares, and reports three
 * violation kinds:
 *
 * - `undeclared-workspace-dep` — package A imports sibling package B by name
 *   but declares no dependency on B (phantom dependency on hoisting).
 * - `undeclared-external-dep` — a file imports a third-party package that is
 *   declared neither in its package's manifest nor at the workspace root.
 * - `cross-package-relative-import` — a file reaches into a sibling package
 *   via a relative path, bypassing its public entry point (flagged even when
 *   the dependency is declared).
 *
 * Classification is per raw specifier, so a file that imports a sibling both
 * by name and via a relative path gets both findings. Node builtins (with or
 * without the `node:` prefix) and self-imports are exempt. Violations are
 * grouped per (package, target, kind) with the offending files listed.
 *
 * A specifier covered by a tsconfig `paths` alias names a file in the
 * workspace, not a package. It is judged by the package that file belongs
 * to: nothing to declare inside the importer's own package, an
 * `undeclared-workspace-dep` when the alias reaches into a sibling.
 */

import { builtinModules } from "node:module";
import path from "node:path";
import type { SymbolGraph } from "../semantic/symbol-graph.js";
import {
	isRelativeSpecifier,
	resolveAliasImport,
	resolveRelativeImport,
} from "./import-graph.js";
import type { PathAlias } from "./tsconfig-paths.js";
import { aliasesInScope, matchPathAlias } from "./tsconfig-paths.js";

export type WorkspaceViolationKind =
	| "undeclared-workspace-dep"
	| "undeclared-external-dep"
	| "cross-package-relative-import";

export interface WorkspaceViolation {
	kind: WorkspaceViolationKind;
	/** Offending workspace package name. */
	package: string;
	/** Imported package name (workspace sibling or external). */
	target: string;
	/** Files containing the offending imports, sorted. */
	files: string[];
}

export interface WorkspacePackageInfo {
	name: string;
	/** Workspace-relative POSIX dir. */
	dir: string;
	/** Union of dependencies, devDependencies, and peerDependencies names. */
	declared: ReadonlySet<string>;
}

export interface WorkspaceCheckResult {
	packagesChecked: number;
	violations: WorkspaceViolation[];
}

const BUILTINS = new Set(builtinModules);

export function checkWorkspace(input: {
	symbolGraph: SymbolGraph;
	packages: WorkspacePackageInfo[];
	/** Root package.json dependency names — satisfies external imports. */
	rootDeclared?: ReadonlySet<string>;
	/** tsconfig `paths` aliases; a specifier one covers is not a package. */
	pathAliases?: readonly PathAlias[];
}): WorkspaceCheckResult {
	const { symbolGraph, packages } = input;
	const rootDeclared = input.rootDeclared ?? new Set<string>();
	const byName = new Map(packages.map((p) => [p.name, p]));
	const files = new Set(Object.keys(symbolGraph.files));
	const grouped = new Map<string, WorkspaceViolation>();

	const addViolation = (
		kind: WorkspaceViolationKind,
		pkg: string,
		target: string,
		file: string,
	): void => {
		const key = `${kind}|${pkg}|${target}`;
		let violation = grouped.get(key);
		if (violation === undefined) {
			violation = { kind, package: pkg, target, files: [] };
			grouped.set(key, violation);
		}
		if (!violation.files.includes(file)) violation.files.push(file);
	};

	for (const file of [...files].sort()) {
		const owner = fileToPackage(file, packages);
		if (owner === undefined) continue;
		const aliases = aliasesInScope(file, input.pathAliases ?? []);

		for (const imp of symbolGraph.files[file]?.imports ?? []) {
			// A computed specifier's prefix is not a package name to check.
			if (imp.kind === "pattern") continue;
			const spec = imp.module;

			if (isRelativeSpecifier(spec)) {
				const target = resolveRelativeImport(file, spec, files);
				if (target === undefined) continue;
				const targetOwner = fileToPackage(target, packages);
				if (targetOwner !== undefined && targetOwner.name !== owner.name) {
					addViolation(
						"cross-package-relative-import",
						owner.name,
						targetOwner.name,
						file,
					);
				}
				continue;
			}

			// Before the package-name reading, as the compiler applies `paths`
			// before it looks in node_modules. An alias that names no indexed
			// file (a stylesheet, a JSON file) is still not a package.
			if (matchPathAlias(spec, aliases).length > 0) {
				const target = resolveAliasImport(spec, aliases, files);
				const targetOwner =
					target === undefined ? undefined : fileToPackage(target, packages);
				if (
					targetOwner !== undefined &&
					targetOwner.name !== owner.name &&
					!owner.declared.has(targetOwner.name)
				) {
					addViolation(
						"undeclared-workspace-dep",
						owner.name,
						targetOwner.name,
						file,
					);
				}
				continue;
			}

			const name = packageNameOf(stripNodePrefix(spec));
			if (name === undefined || BUILTINS.has(name)) continue;
			if (spec.startsWith("node:") || name === owner.name) continue;

			if (byName.has(name)) {
				if (!owner.declared.has(name)) {
					addViolation("undeclared-workspace-dep", owner.name, name, file);
				}
				continue;
			}
			if (!owner.declared.has(name) && !rootDeclared.has(name)) {
				addViolation("undeclared-external-dep", owner.name, name, file);
			}
		}
	}

	const violations = [...grouped.values()]
		.map((v) => ({ ...v, files: [...v.files].sort() }))
		.sort(
			(a, b) =>
				a.package.localeCompare(b.package) ||
				a.target.localeCompare(b.target) ||
				a.kind.localeCompare(b.kind),
		);

	return { packagesChecked: packages.length, violations };
}

/** Longest-prefix owner lookup over workspace-relative POSIX dirs. */
function fileToPackage(
	file: string,
	packages: WorkspacePackageInfo[],
): WorkspacePackageInfo | undefined {
	let best: WorkspacePackageInfo | undefined;
	let bestLength = -1;
	for (const pkg of packages) {
		// A root package's dir is "" and owns every file no deeper package does.
		const prefix = pkg.dir === "" ? "" : `${pkg.dir}/`;
		if (file.startsWith(prefix) && prefix.length > bestLength) {
			best = pkg;
			bestLength = prefix.length;
		}
	}
	return best;
}

/** `@scope/pkg/deep` -> `@scope/pkg`; `pkg/deep` -> `pkg`. */
function packageNameOf(spec: string): string | undefined {
	const segments = spec.split("/");
	const nameLength = spec.startsWith("@") ? 2 : 1;
	if (segments.length < nameLength) return undefined;
	const name = segments.slice(0, nameLength).join("/");
	return name === "" ? undefined : name;
}

function stripNodePrefix(spec: string): string {
	return spec.startsWith("node:") ? spec.slice(5) : spec;
}

export interface DependencyManifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

export interface PackageManifest extends DependencyManifest {
	name?: string;
}

/** Version ranges that point inside the repository rather than at a registry. */
const LOCAL_PROTOCOL = /^(?:workspace|link|file|portal):/;

/** Names listed in one note before the rest become a count. */
const MAX_NOTE_NAMES = 3;

/**
 * Where the import graph can be missing edges because workspace discovery or
 * alias reading came up short. Resolution treats a bare specifier it cannot
 * place as a third-party package, so a workspace package discovery missed, or
 * a `paths` alias from a tsconfig variant did not read, drops out of the graph
 * without a trace: changes to it reach none of its importers.
 *
 * Unlike `checkWorkspace` this covers every file, root included, and returns
 * notes rather than violations: the missed importer is by definition not in
 * the blast radius, so scoping this to affected files would hide the case.
 */
export function workspaceBlindSpots(input: {
	/** Bare specifiers per file, as `ImportGraph.externals` records them. */
	externals: ReadonlyMap<string, ReadonlySet<string>>;
	/** Names of the workspace packages discovery found. */
	packageNames: ReadonlySet<string>;
	/**
	 * Every `package.json` in the repository by workspace-relative POSIX dir,
	 * "" for the root. A file's imports are checked against its nearest one,
	 * so nested packages that are not workspace members (test fixtures,
	 * examples) are judged by their own manifests.
	 */
	manifests: ReadonlyMap<string, PackageManifest>;
}): string[] {
	const { packageNames, manifests } = input;
	const root = manifests.get("") ?? {};
	const rootDeclared = new Set(Object.keys(allDependencies(root)));
	const notes: string[] = [];

	const missingLocal = new Set<string>();
	for (const [dir, manifest] of manifests) {
		const member =
			dir === "" ||
			(manifest.name !== undefined && packageNames.has(manifest.name));
		if (!member) continue;
		for (const [name, range] of Object.entries(allDependencies(manifest))) {
			if (LOCAL_PROTOCOL.test(range) && !packageNames.has(name)) {
				missingLocal.add(name);
			}
		}
	}
	if (missingLocal.size > 0) {
		const one = missingLocal.size === 1;
		notes.push(
			`${missingLocal.size} ${one ? "dependency" : "dependencies"} declared with a local protocol ${one ? "is not a workspace package" : "are not workspace packages"} variant found (${listNames(missingLocal)}); imports of ${one ? "it" : "them"} count as external, so a change to ${one ? "it" : "them"} reaches no importer`,
		);
	}

	const undeclared = new Set<string>();
	for (const [file, specs] of input.externals) {
		const nearest = nearestManifest(file, manifests) ?? root;
		const declared = allDependencies(nearest);
		for (const spec of specs) {
			// `node:`, `virtual:`, `bun:` and similar schemes name no package.
			if (spec.includes(":")) continue;
			const name = packageNameOf(spec);
			if (name === undefined || BUILTINS.has(name)) continue;
			if (name === nearest.name || packageNames.has(name)) continue;
			if (name in declared || rootDeclared.has(name)) continue;
			if (!missingLocal.has(name)) undeclared.add(name);
		}
	}
	if (undeclared.size > 0) {
		const one = undeclared.size === 1;
		notes.push(
			`${undeclared.size} bare import ${one ? "name is" : "names are"} neither workspace packages nor declared dependencies (${listNames(undeclared)}); if one is a workspace package variant did not find, or a tsconfig alias it did not read, a change behind it reaches no test`,
		);
	}

	return notes;
}

function nearestManifest(
	file: string,
	manifests: ReadonlyMap<string, PackageManifest>,
): PackageManifest | undefined {
	let dir = path.posix.dirname(file);
	while (true) {
		const manifest = manifests.get(dir === "." ? "" : dir);
		if (manifest !== undefined) return manifest;
		if (dir === "." || dir === "/" || dir === "") return undefined;
		dir = path.posix.dirname(dir);
	}
}

function allDependencies(manifest: DependencyManifest): Record<string, string> {
	return {
		...(manifest.dependencies ?? {}),
		...(manifest.devDependencies ?? {}),
		...(manifest.peerDependencies ?? {}),
		...(manifest.optionalDependencies ?? {}),
	};
}

function listNames(names: ReadonlySet<string>): string {
	const sorted = [...names].sort();
	return sorted.length > MAX_NOTE_NAMES
		? `${sorted.slice(0, MAX_NOTE_NAMES).join(", ")}, … ${sorted.length - MAX_NOTE_NAMES} more`
		: sorted.join(", ");
}
