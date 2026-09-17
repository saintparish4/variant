/**
 * @module
 * File-level reverse import graph. Same shape as
 * `package-graph.ts`, one level finer: for every workspace file, which files
 * it imports and — the inversion — which files depend on it. This is the data
 * structure blast-radius traversal (1.3) hangs on.
 *
 * The graph is derived from the persisted SymbolGraph (`core/semantic/`),
 * which already extracts per-file imports incrementally (only changed files
 * are re-parsed). Derivation itself is cheap string work with no filesystem
 * access — specifiers are resolved against the indexed file set — so the
 * import graph is recomputed from `symbols.json` on demand rather than
 * persisted separately; the expensive parse work is what the disk cache
 * amortizes.
 *
 * Resolution is best-effort per NodeNext conventions: relative specifiers map
 * `.js`/`.mjs`/`.cjs`/`.jsx` to their TS sources and try index files; bare
 * specifiers resolve into sibling workspace packages when `packageDirs` is
 * provided, and count as externals otherwise. Internal-looking specifiers
 * that fail to resolve (missing files, non-TS assets, tsconfig path aliases)
 * are reported in `unresolved` so downstream consumers can lower confidence
 * instead of silently missing edges.
 */

import path from "node:path";
import type { ImportEntry, SymbolGraph } from "../semantic/symbol-graph.js";
import type { PackageGraph } from "./package-graph.js";

export interface ImportGraph {
	/** file -> workspace files it imports (resolved, workspace-relative POSIX). */
	imports: ReadonlyMap<string, ReadonlySet<string>>;
	/** file -> files that import it. The inversion — `Map<file, dependents[]>`. */
	dependents: ReadonlyMap<string, ReadonlySet<string>>;
	/** file -> bare external specifiers (package names, `node:` builtins). */
	externals: ReadonlyMap<string, ReadonlySet<string>>;
	/** file -> internal-looking specifiers that did not resolve to an indexed file. */
	unresolved: ReadonlyMap<string, ReadonlySet<string>>;
	/**
	 * importer -> imported file -> edge metadata. Records which names the
	 * importer takes from the target so blast-radius traversal (1.3) can gate
	 * propagation per symbol instead of per file.
	 */
	edges: ReadonlyMap<string, ReadonlyMap<string, ImportEdge>>;
}

export interface ImportEdge {
	/**
	 * Names taken from the target: exported names, "default", or "*" for
	 * namespace imports and wildcard re-exports.
	 */
	names: ReadonlySet<string>;
	/** True when every import contributing to this edge is type-only. */
	typeOnly: boolean;
	/** True when a dynamic import() contributes — the names are unknowable. */
	dynamic: boolean;
}

export interface ImportGraphOptions {
	/**
	 * Workspace package name -> workspace-relative POSIX dir. Enables resolving
	 * bare imports of sibling packages (`@org/auth` -> `packages/auth/...`).
	 */
	packageDirs?: Record<string, string>;
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

const JS_TO_TS: Record<string, readonly string[]> = {
	".js": [".ts", ".tsx"],
	".mjs": [".mts"],
	".cjs": [".cts"],
	".jsx": [".tsx"],
};

/** Derive the file-level import graph from a built SymbolGraph. */
export function buildImportGraph(
	symbolGraph: SymbolGraph,
	options: ImportGraphOptions = {},
): ImportGraph {
	const files = new Set(Object.keys(symbolGraph.files));
	const packageDirs = options.packageDirs ?? {};

	const imports = new Map<string, Set<string>>();
	const dependents = new Map<string, Set<string>>();
	const externals = new Map<string, Set<string>>();
	const unresolved = new Map<string, Set<string>>();
	const edges = new Map<string, Map<string, MutableImportEdge>>();
	for (const file of [...files].sort()) {
		imports.set(file, new Set());
		dependents.set(file, new Set());
		externals.set(file, new Set());
		unresolved.set(file, new Set());
		edges.set(file, new Map());
	}

	const addEdge = (from: string, to: string, imp: ImportEntry): void => {
		imports.get(from)?.add(to);
		const perFile = edges.get(from);
		if (perFile === undefined) return;
		let edge = perFile.get(to);
		if (edge === undefined) {
			edge = { names: new Set(), typeOnly: true, dynamic: false };
			perFile.set(to, edge);
		}
		for (const name of imp.names) edge.names.add(name);
		if (imp.kind === "dynamic") edge.dynamic = true;
		edge.typeOnly = edge.typeOnly && imp.typeOnly;
	};

	for (const file of [...files].sort()) {
		const index = symbolGraph.files[file];
		if (index === undefined) continue;
		for (const imp of index.imports) {
			const spec = imp.module;
			if (spec.startsWith("./") || spec.startsWith("../")) {
				const resolved = resolveRelativeImport(file, spec, files);
				if (resolved === undefined) unresolved.get(file)?.add(spec);
				else addEdge(file, resolved, imp);
				continue;
			}
			if (spec.startsWith("node:")) {
				externals.get(file)?.add(spec);
				continue;
			}
			const pkg = matchWorkspacePackage(spec, packageDirs);
			if (pkg === undefined) {
				externals.get(file)?.add(spec);
				continue;
			}
			const resolved = resolvePackageImport(pkg.dir, pkg.subpath, files);
			if (resolved === undefined) unresolved.get(file)?.add(spec);
			else addEdge(file, resolved, imp);
		}
	}

	for (const [file, targets] of imports) {
		for (const target of targets) {
			dependents.get(target)?.add(file);
		}
	}

	return { imports, dependents, externals, unresolved, edges };
}

interface MutableImportEdge {
	names: Set<string>;
	typeOnly: boolean;
	dynamic: boolean;
}

/**
 * Convenience wrapper: incrementally update the persisted SymbolGraph for the
 * workspace, then derive the import graph. Pass the workspace `PackageGraph`
 * to resolve bare imports of sibling packages.
 */
export async function loadImportGraph(
	cwd: string,
	options: { graphDir?: string; packageGraph?: PackageGraph } = {},
): Promise<ImportGraph> {
	const { updateSymbolGraph } = await import("../semantic/symbol-graph.js");
	const { graph } = await updateSymbolGraph(
		cwd,
		options.graphDir === undefined ? {} : { graphDir: options.graphDir },
	);

	const packageDirs: Record<string, string> = {};
	for (const pkg of options.packageGraph?.packages ?? []) {
		packageDirs[pkg.manifest.name] = path
			.relative(cwd, pkg.dir)
			.replace(/\\/g, "/");
	}
	return buildImportGraph(graph, { packageDirs });
}

/** Files that directly import `file`. Empty set for unknown files. */
export function getDependents(
	graph: ImportGraph,
	file: string,
): ReadonlySet<string> {
	return graph.dependents.get(toPosix(file)) ?? new Set();
}

/**
 * BFS over the reverse import graph: every file that is directly changed OR
 * transitively imports a changed file. The file-level analogue of
 * `computeAffectedPackages` in package-graph.ts — and the blast-radius
 * primitive for `variant impact`.
 */
export function computeAffectedFiles(
	changed: ReadonlySet<string>,
	graph: ImportGraph,
): Set<string> {
	const affected = new Set<string>();
	for (const file of changed) affected.add(toPosix(file));

	let frontier = new Set<string>(affected);
	while (frontier.size > 0) {
		const next = new Set<string>();
		for (const file of frontier) {
			for (const dependent of graph.dependents.get(file) ?? []) {
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

/**
 * Resolve a relative specifier from `fromFile` against a set of indexed
 * workspace files (NodeNext extension mapping). Exported for consumers that
 * need per-specifier resolution, e.g. workspace-check's reach-in detection.
 */
export function resolveRelativeImport(
	fromFile: string,
	spec: string,
	files: ReadonlySet<string>,
): string | undefined {
	const base = path.posix.normalize(
		path.posix.join(path.posix.dirname(fromFile), spec),
	);
	// Escapes the workspace root — cannot be an indexed file.
	if (base.startsWith("../")) return undefined;
	return firstExisting(candidatePaths(base), files);
}

function resolvePackageImport(
	pkgDir: string,
	subpath: string,
	files: ReadonlySet<string>,
): string | undefined {
	if (subpath === "") {
		return firstExisting(
			[
				...candidatePaths(`${pkgDir}/src/index`),
				...candidatePaths(`${pkgDir}/index`),
			],
			files,
		);
	}
	return firstExisting(
		[
			...candidatePaths(path.posix.join(pkgDir, subpath)),
			...candidatePaths(path.posix.join(pkgDir, "src", subpath)),
		],
		files,
	);
}

function matchWorkspacePackage(
	spec: string,
	packageDirs: Record<string, string>,
): { dir: string; subpath: string } | undefined {
	const segments = spec.split("/");
	const nameLength = spec.startsWith("@") ? 2 : 1;
	if (segments.length < nameLength) return undefined;
	const name = segments.slice(0, nameLength).join("/");
	const dir = packageDirs[name];
	if (dir === undefined) return undefined;
	return { dir: toPosix(dir), subpath: segments.slice(nameLength).join("/") };
}

/**
 * Candidate indexed files for a resolved, extensionful-or-not base path:
 * exact TS path, JS-extension remaps (`.js` -> `.ts`/`.tsx`, …), then
 * extension probing and `index.*` for extensionless specifiers.
 */
function candidatePaths(base: string): string[] {
	const ext = path.posix.extname(base);
	if ((TS_EXTENSIONS as readonly string[]).includes(ext)) {
		return [base];
	}
	const tsExts = JS_TO_TS[ext];
	if (tsExts !== undefined) {
		const stem = base.slice(0, -ext.length);
		return tsExts.map((e) => stem + e);
	}
	// Extensionless (or an unknown "extension" that is really a dotted name).
	return [
		...TS_EXTENSIONS.map((e) => base + e),
		...TS_EXTENSIONS.map((e) => `${base}/index${e}`),
	];
}

function firstExisting(
	candidates: string[],
	files: ReadonlySet<string>,
): string | undefined {
	for (const c of candidates) {
		if (files.has(c)) return c;
	}
	return undefined;
}

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}
