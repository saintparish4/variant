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
 * provided, then through tsconfig `paths` aliases when `pathAliases` is, and
 * count as externals otherwise. Internal-looking specifiers that fail to
 * resolve (missing files, non-TS assets) are reported in `unresolved` so
 * downstream consumers can lower confidence instead of silently missing
 * edges.
 */

import path from "node:path";
import type { ImportEntry, SymbolGraph } from "../semantic/symbol-graph.js";
import { exportsCandidates } from "./package-exports.js";
import type { PackageGraph } from "./package-graph.js";
import type { PathAlias } from "./tsconfig-paths.js";
import { aliasesInScope, matchPathAlias } from "./tsconfig-paths.js";

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
	/**
	 * Files that load a module through a computed specifier with no static
	 * prefix (`import(name)`). What they load cannot be bounded, so no edge
	 * stands for it.
	 */
	computed: ReadonlySet<string>;
	/**
	 * Workspace path an unresolved specifier names -> files importing it. A
	 * changed file the index does not cover (a stylesheet, JSON, JavaScript)
	 * has no node in the graph, and this is how it still reaches its importers.
	 * See `importersOfUnindexed`.
	 */
	unresolvedTargets: ReadonlyMap<string, ReadonlySet<string>>;
	/** Static prefix of a computed specifier -> files loading through it. */
	patternTargets: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ImportEdge {
	/**
	 * Names taken from the target: exported names, "default", or "*" for
	 * namespace imports and wildcard re-exports.
	 */
	names: ReadonlySet<string>;
	/** True when every import contributing to this edge is type-only. */
	typeOnly: boolean;
	/**
	 * True when a dynamic `import()` or a computed specifier contributes — the
	 * names are unknowable.
	 */
	dynamic: boolean;
}

export interface ImportGraphOptions {
	/**
	 * Workspace package name -> workspace-relative POSIX dir. Enables resolving
	 * bare imports of sibling packages (`@org/auth` -> `packages/auth/...`).
	 */
	packageDirs?: Record<string, string>;
	/**
	 * tsconfig `paths` aliases. Tried after workspace packages, so a package
	 * name always wins over an alias that happens to share its prefix.
	 */
	pathAliases?: readonly PathAlias[];
	/**
	 * Workspace package name -> its `package.json` `exports` field. Consulted
	 * before the conventional entry-point guesses, which remain the fallback.
	 */
	packageExports?: Record<string, unknown>;
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx"]);

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
	const allAliases = options.pathAliases ?? [];
	const packageExports = options.packageExports ?? {};

	const imports = new Map<string, Set<string>>();
	const dependents = new Map<string, Set<string>>();
	const externals = new Map<string, Set<string>>();
	const unresolved = new Map<string, Set<string>>();
	const edges = new Map<string, Map<string, MutableImportEdge>>();
	const computed = new Set<string>();
	const unresolvedTargets = new Map<string, Set<string>>();
	const patternTargets = new Map<string, Set<string>>();
	const sortedFiles = [...files].sort();
	for (const file of sortedFiles) {
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
		if (imp.kind === "dynamic" || imp.kind === "pattern") edge.dynamic = true;
		edge.typeOnly = edge.typeOnly && imp.typeOnly;
	};

	const addUnresolved = (
		from: string,
		spec: string,
		bases: readonly string[],
	): void => {
		unresolved.get(from)?.add(spec);
		for (const base of bases) {
			for (const key of unresolvedKeys(base))
				addTo(unresolvedTargets, key, from);
		}
	};

	for (const file of sortedFiles) {
		const index = symbolGraph.files[file];
		if (index === undefined) continue;
		const pathAliases = aliasesInScope(file, allAliases);
		for (const imp of index.imports) {
			const spec = imp.module;
			if (imp.kind === "pattern") {
				const bases = patternBases(file, spec, packageDirs, pathAliases);
				if (bases === undefined) {
					computed.add(file);
					continue;
				}
				for (const base of bases) addTo(patternTargets, base, file);
				// Every indexed file the specifier could name gets an edge: wider
				// than the truth, but a missed edge is a missed test.
				for (const target of sortedFiles) {
					if (target !== file && bases.some((b) => target.startsWith(b))) {
						addEdge(file, target, imp);
					}
				}
				continue;
			}
			if (isRelativeSpecifier(spec)) {
				const resolved = resolveRelativeImport(file, spec, files);
				if (resolved !== undefined) {
					addEdge(file, resolved, imp);
					continue;
				}
				// A base above the indexed directory stays `../…`, which is how
				// git lists a file changed elsewhere in the repository.
				addUnresolved(file, spec, [
					path.posix.join(path.posix.dirname(file), spec),
				]);
				continue;
			}
			if (spec.startsWith("node:")) {
				externals.get(file)?.add(spec);
				continue;
			}
			const pkg = matchWorkspacePackage(spec, packageDirs);
			if (pkg !== undefined) {
				const resolved = resolvePackageImport(
					pkg.dir,
					pkg.subpath,
					files,
					packageExports[pkg.name],
				);
				if (resolved !== undefined) {
					addEdge(file, resolved, imp);
					continue;
				}
				addUnresolved(
					file,
					spec,
					pkg.subpath === ""
						? [pkg.dir]
						: [
								path.posix.join(pkg.dir, pkg.subpath),
								path.posix.join(pkg.dir, "src", pkg.subpath),
							],
				);
				continue;
			}
			const aliased = resolveAliasImport(spec, pathAliases, files);
			if (aliased !== undefined) {
				addEdge(file, aliased, imp);
				continue;
			}
			// An alias that matched a pattern but named no indexed file is a
			// missed internal edge, not a third-party package — say so rather
			// than quietly counting it as external.
			const aliasBases = matchPathAlias(spec, pathAliases);
			if (aliasBases.length > 0) {
				addUnresolved(file, spec, aliasBases);
				continue;
			}
			externals.get(file)?.add(spec);
		}
	}

	for (const [file, targets] of imports) {
		for (const target of targets) {
			dependents.get(target)?.add(file);
		}
	}

	return {
		imports,
		dependents,
		externals,
		unresolved,
		edges,
		computed,
		unresolvedTargets,
		patternTargets,
	};
}

/**
 * Files whose unresolved imports, or computed specifiers, could name `file`.
 * For a file the index does not cover this stands in for `dependents`: a
 * TypeScript file importing `./button.css` has that specifier in
 * `unresolved`, and a change to the stylesheet reaches it through here.
 */
export function importersOfUnindexed(
	graph: ImportGraph,
	file: string,
): Set<string> {
	const target = toPosix(file);
	const stem = stripSourceExtension(target);
	const keys = [target, stem];
	if (path.posix.basename(stem) === "index") {
		keys.push(path.posix.dirname(stem));
	}

	const importers = new Set<string>();
	for (const key of keys) {
		for (const importer of graph.unresolvedTargets.get(key) ?? []) {
			importers.add(importer);
		}
	}
	for (const [prefix, loaders] of graph.patternTargets) {
		if (!target.startsWith(prefix)) continue;
		for (const loader of loaders) importers.add(loader);
	}
	return importers;
}

/**
 * Keys an unresolved base is filed under: as written, and without a JS
 * extension, since `./legacy.js` may name `legacy.jsx` or a `legacy.d.ts`.
 */
function unresolvedKeys(base: string): string[] {
	const ext = path.posix.extname(base);
	return JS_EXTENSIONS.has(ext) ? [base, base.slice(0, -ext.length)] : [base];
}

/** `a/b.d.ts` -> `a/b`, `a/b.css` -> `a/b`. */
function stripSourceExtension(file: string): string {
	const declaration = /\.d\.[cm]?ts$/.exec(file);
	if (declaration !== null) return file.slice(0, declaration.index);
	const ext = path.posix.extname(file);
	return ext === "" ? file : file.slice(0, -ext.length);
}

function addTo(
	map: Map<string, Set<string>>,
	key: string,
	value: string,
): void {
	let set = map.get(key);
	if (set === undefined) {
		set = new Set();
		map.set(key, set);
	}
	set.add(value);
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
	const { readPathAliases } = await import("./tsconfig-paths.js");
	const [{ graph }, pathAliases] = await Promise.all([
		updateSymbolGraph(
			cwd,
			options.graphDir === undefined ? {} : { graphDir: options.graphDir },
		),
		readPathAliases(cwd),
	]);

	const packageDirs: Record<string, string> = {};
	const packageExports: Record<string, unknown> = {};
	for (const pkg of options.packageGraph?.packages ?? []) {
		packageDirs[pkg.manifest.name] = path
			.relative(cwd, pkg.dir)
			.replace(/\\/g, "/");
		if (pkg.manifest.exports !== undefined) {
			packageExports[pkg.manifest.name] = pkg.manifest.exports;
		}
	}
	return buildImportGraph(graph, { packageDirs, pathAliases, packageExports });
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
	if (base === ".." || base.startsWith("../")) return undefined;
	// `import x from "."` in a root-level file: the workspace's own index.
	return firstExisting(candidatePaths(base === "." ? "index" : base), files);
}

/**
 * `"."` and `".."` are relative too: the index file of the importing file's
 * directory, and of its parent. Read as package names they had no edge, so a
 * test written `import { x } from ".."` had no link to the code it tests.
 */
export function isRelativeSpecifier(spec: string): boolean {
	return (
		spec === "." ||
		spec === ".." ||
		spec.startsWith("./") ||
		spec.startsWith("../")
	);
}

/**
 * Path prefixes a computed specifier's static prefix can name. Undefined when
 * it could name anything; [] when it can only name something outside the
 * workspace (a third-party package, a node builtin, a path above the root).
 */
function patternBases(
	fromFile: string,
	prefix: string,
	packageDirs: Record<string, string>,
	aliases: readonly PathAlias[],
): string[] | undefined {
	if (prefix === "") return undefined;

	if (prefix.startsWith(".")) {
		const base = path.posix.join(path.posix.dirname(fromFile), prefix);
		return [base === "." || base === "./" ? "" : base];
	}
	if (prefix.startsWith("node:")) return [];

	const bases: string[] = [];
	for (const [name, dir] of Object.entries(packageDirs)) {
		// A subpath could resolve anywhere in the package through `exports`, so
		// the whole package is the bound.
		if (prefix.startsWith(`${name}/`) || name.startsWith(prefix)) {
			bases.push(`${toPosix(dir)}/`);
		}
	}
	for (const alias of aliases) {
		for (const target of alias.targets) {
			const targetStem = alias.wildcard
				? target.slice(0, target.indexOf("*"))
				: target;
			if (alias.wildcard && prefix.startsWith(alias.prefix)) {
				bases.push(targetStem + prefix.slice(alias.prefix.length));
			} else if (alias.prefix.startsWith(prefix)) {
				bases.push(targetStem);
			}
		}
	}
	if (bases.length > 0) return bases;

	// A complete package name followed by `/` names a package variant does not
	// index. A prefix that stops inside the name could be any package at all.
	const segments = prefix.split("/");
	const nameLength = prefix.startsWith("@") ? 2 : 1;
	return segments.length > nameLength ? [] : undefined;
}

function resolvePackageImport(
	pkgDir: string,
	subpath: string,
	files: ReadonlySet<string>,
	exportsField?: unknown,
): string | undefined {
	// `exports` names the published entry point, so it is the most direct
	// evidence of what a bare import means. The conventional guesses below stay
	// as the fallback: a package without `exports`, or one whose targets name
	// no indexed file, must resolve exactly as it did before.
	const fromExports = exportsCandidates(exportsField, subpath);
	const candidates = fromExports.flatMap((base) =>
		candidatePaths(path.posix.join(pkgDir, base)),
	);

	if (subpath === "") {
		candidates.push(
			...candidatePaths(`${pkgDir}/src/index`),
			...candidatePaths(`${pkgDir}/index`),
		);
	} else {
		candidates.push(
			...candidatePaths(path.posix.join(pkgDir, subpath)),
			...candidatePaths(path.posix.join(pkgDir, "src", subpath)),
		);
	}

	return firstExisting(candidates, files);
}

/**
 * Resolve a specifier through tsconfig `paths` to an indexed file. Exported
 * for workspace-check, which has to tell an aliased import of a workspace
 * file from an import of a package.
 */
export function resolveAliasImport(
	spec: string,
	aliases: readonly PathAlias[],
	files: ReadonlySet<string>,
): string | undefined {
	for (const base of matchPathAlias(spec, aliases)) {
		const resolved = firstExisting(candidatePaths(base), files);
		if (resolved !== undefined) return resolved;
	}
	return undefined;
}

function matchWorkspacePackage(
	spec: string,
	packageDirs: Record<string, string>,
): { name: string; dir: string; subpath: string } | undefined {
	const segments = spec.split("/");
	const nameLength = spec.startsWith("@") ? 2 : 1;
	if (segments.length < nameLength) return undefined;
	const name = segments.slice(0, nameLength).join("/");
	const dir = packageDirs[name];
	if (dir === undefined) return undefined;
	return {
		name,
		dir: toPosix(dir),
		subpath: segments.slice(nameLength).join("/"),
	};
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
