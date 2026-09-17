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
 */

import { builtinModules } from "node:module";
import type { SymbolGraph } from "../semantic/symbol-graph.js";
import { resolveRelativeImport } from "./import-graph.js";

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

		for (const imp of symbolGraph.files[file]?.imports ?? []) {
			const spec = imp.module;

			if (spec.startsWith("./") || spec.startsWith("../")) {
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
		const prefix = `${pkg.dir}/`;
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
