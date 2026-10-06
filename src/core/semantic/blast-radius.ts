/**
 * @module
 * Blast-radius traversal. Given changed files, walks the chain
 * `File → Import → Package → Task`: classify each changed file with the
 * signature-level differ, gate propagation semantically, BFS the reverse
 * import graph, then map affected files to workspace packages and tasks.
 *
 * The semantic gating is what separates this from "it imported the file, so
 * rerun it":
 * - `non-impacting` changes are not even seeds;
 * - `unanalyzed` changes (files the index does not cover, such as a
 *   stylesheet or JSON) reach the files whose unresolved imports name them;
 * - `internal` (body-only) changes affect the file itself but do NOT
 *   propagate to dependents;
 * - `breaking` (signature/type) changes propagate — and the first hop is
 *   gated per symbol: a dependent that imports only untouched names is
 *   skipped. Beyond the first hop propagation is structural, because a
 *   dependent's own inferred surface may have changed in ways single-file
 *   analysis cannot see.
 *
 * Anything the analysis cannot prove (dynamic imports, unresolved specifiers,
 * non-TS files, `export *`) widens the radius or lowers the confidence score
 * instead of silently passing.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TaskConfig } from "../../types/index.js";
import { getChangedFiles } from "../cache/git-diff.js";
import { mapLimit } from "../execution/concurrency.js";
import type { ImportGraph } from "../graph/import-graph.js";
import {
	buildImportGraph,
	computeAffectedFiles,
	importersOfUnindexed,
} from "../graph/import-graph.js";
import type { PackageGraph } from "../graph/package-graph.js";
import type { PathAlias } from "../graph/tsconfig-paths.js";
import { readPathAliases } from "../graph/tsconfig-paths.js";
import { readManifests } from "../graph/workspace-audit.js";
import { workspaceBlindSpots } from "../graph/workspace-check.js";
import { readFileAtRef, readFilesAtRef } from "../vcs/git.js";
import type { ClassifyResult, SemanticClass } from "./differ.js";
import { createClassifier } from "./differ.js";
import { isStarReexportKey } from "./surface.js";
import { updateSymbolGraph } from "./symbol-graph.js";

/** `unanalyzed` = changed file the semantic differ cannot parse (non-TS). */
export type ImpactClass = SemanticClass | "unanalyzed";

export interface FileImpact {
	filePath: string;
	classification: ImpactClass;
	/**
	 * Exported symbols whose public shape changed or that were removed — the
	 * set a dependent must import (or wildcard) for the first hop to propagate.
	 */
	impactedSymbols: string[];
	/** True when this change propagates through the reverse import graph. */
	propagates: boolean;
	/**
	 * True when no importer can be gated out by the names it takes: a changed
	 * star re-export, or a file that does not parse.
	 */
	ungated?: boolean;
	notes: string[];
}

export interface BlastRadius {
	baseRef: string;
	changed: FileImpact[];
	/** Changed files needing work plus every transitively affected dependent. */
	affectedFiles: string[];
	affectedPackages: string[];
	/** Tasks named `<package>:<script>` for affected packages. */
	affectedTasks: string[];
	/** 1 when fully resolved; lowered per unprovable construct. Floor 0.3. */
	confidence: number;
	notes: string[];
}

const TS_FILE = /\.(?:ts|tsx|mts|cts)$/;

/** Files named in one aggregated note before the rest become a count. */
const MAX_NOTE_FILES = 3;

/**
 * Classification is CPU-bound in ts-morph, so this is not about parallel
 * parsing — it is about overlapping each file's working-tree read with the
 * previous file's parse.
 */
const CLASSIFY_CONCURRENCY = 16;

/**
 * Git lists every file a change touches, and the symbol index covers `cwd`
 * only. A changed file above `cwd` has no node to propagate from, so it is
 * handled like any other file the index does not cover: it reaches the files
 * whose imports name it, and is reported when none does.
 */
function isOutsideWorkspace(file: string): boolean {
	return file.startsWith("../");
}

function isAnalyzable(file: string): boolean {
	return (
		TS_FILE.test(file) && !file.endsWith(".d.ts") && !isOutsideWorkspace(file)
	);
}

/**
 * A `readBefore` backed by one batched `git cat-file`, falling back to a
 * `git show` per file if the batch is unavailable or unparseable.
 */
async function batchedReaderFor(
	cwd: string,
	baseRef: string,
	relPaths: string[],
): Promise<(relPath: string) => Promise<string | null>> {
	const batch = await readFilesAtRef(cwd, baseRef, relPaths);
	if (batch === null) return (rel) => readFileAtRef(cwd, baseRef, rel);
	return async (rel) => batch.get(rel) ?? null;
}

export interface TraceBlastRadiusOptions {
	/** Git ref to diff against. Defaults to HEAD~1 (matches `diff`/git-diff). */
	baseRef?: string;
	/** Skip git and use these workspace-relative paths as the changed set. */
	changedFiles?: string[];
	/** Enables file→package→task mapping and workspace-package resolution. */
	packageGraph?: PackageGraph;
	/** Task map (e.g. from the planner); matched by `<package>:` name prefix. */
	tasks?: Record<string, TaskConfig>;
	/** Where the persisted symbol graph lives. Default `.variant/graph/`. */
	graphDir?: string;
	/** Reuse a prebuilt import graph (skips the symbol-graph update). */
	importGraph?: ImportGraph;
	/**
	 * DI for tests: tsconfig `paths` aliases. Read from the workspace tsconfig
	 * when omitted — an unresolved alias edge is a missed dependent, which is
	 * the direction that produces a false skip.
	 */
	pathAliases?: readonly PathAlias[];
	/** DI for tests: content of a file at baseRef (null = didn't exist). */
	readBefore?: (relPath: string) => Promise<string | null>;
	/** DI for tests: current content of a file (null = deleted). */
	readAfter?: (relPath: string) => Promise<string | null>;
}

/**
 * Full pipeline: changed files (git or injected) → semantic classification →
 * gated reverse-graph traversal → package/task mapping.
 *
 * Returns null when the changed set is unavailable (git missing and no
 * `changedFiles` given), mirroring `getChangedFiles`.
 */
export async function traceBlastRadius(
	cwd: string,
	options: TraceBlastRadiusOptions = {},
): Promise<BlastRadius | null> {
	const baseRef = options.baseRef ?? "HEAD~1";
	const changedFiles =
		options.changedFiles ?? (await getChangedFiles({ cwd, baseRef }));
	if (changedFiles === null) return null;

	const packageDirs = packageDirsFrom(cwd, options.packageGraph);
	let importGraph = options.importGraph;
	if (importGraph === undefined) {
		const [{ graph: symbolGraph }, pathAliases] = await Promise.all([
			updateSymbolGraph(
				cwd,
				options.graphDir === undefined ? {} : { graphDir: options.graphDir },
			),
			options.pathAliases ?? readPathAliases(cwd),
		]);
		importGraph = buildImportGraph(symbolGraph, {
			packageDirs,
			pathAliases,
			packageExports: packageExportsFrom(options.packageGraph),
		});
	}

	const files = changedFiles.map(toPosix).sort();
	const analyzable = files.filter(isAnalyzable);

	const readBefore =
		options.readBefore ?? (await batchedReaderFor(cwd, baseRef, analyzable));
	const readAfter =
		options.readAfter ??
		(async (rel: string) => {
			try {
				return await readFile(path.join(cwd, rel), "utf8");
			} catch {
				return null;
			}
		});

	// One classifier for the whole traversal: it owns a single ts-morph
	// Project rather than building one per changed file.
	const classify = createClassifier();

	// Per-file work is independent, so it overlaps; mapLimit preserves input
	// order, which keeps the report deterministic.
	const changed = await mapLimit(files, CLASSIFY_CONCURRENCY, async (file) => {
		if (!isAnalyzable(file)) {
			return {
				filePath: file,
				classification: "unanalyzed" as const,
				impactedSymbols: [],
				propagates: false,
				notes: [],
			};
		}
		const [before, after] = await Promise.all([
			readBefore(file),
			readAfter(file),
		]);
		return toFileImpact(
			await classify({
				filePath: file,
				before: before ?? "",
				after: after ?? "",
			}),
		);
	});

	const workspaceNotes = workspaceBlindSpots({
		externals: importGraph.externals,
		packageNames: new Set(
			(options.packageGraph?.packages ?? []).map((pkg) => pkg.manifest.name),
		),
		manifests: await readManifests(cwd),
	});

	return assembleBlastRadius(baseRef, changed, importGraph, {
		packageDirs,
		workspaceNotes,
		...(options.tasks === undefined ? {} : { tasks: options.tasks }),
	});
}

/**
 * Pure core of the traversal — exported for direct use and tests. Applies the
 * semantic gate to each changed file, walks the reverse graph, and maps the
 * affected set onto packages and tasks.
 */
export function assembleBlastRadius(
	baseRef: string,
	changed: FileImpact[],
	importGraph: ImportGraph,
	options: {
		packageDirs?: Record<string, string>;
		tasks?: Record<string, TaskConfig>;
		/** Where the graph may be missing edges; see `workspaceBlindSpots`. */
		workspaceNotes?: readonly string[];
	} = {},
): BlastRadius {
	const notes = new Set<string>(options.workspaceNotes);
	const affected = new Set<string>();
	const firstHop = new Set<string>();

	for (const impact of changed) {
		for (const note of impact.notes) notes.add(note);
		if (impact.classification === "non-impacting") continue;
		affected.add(impact.filePath);
		if (impact.classification === "unanalyzed") {
			// No surface to gate on, so every importer is a first hop.
			for (const importer of importersOfUnindexed(
				importGraph,
				impact.filePath,
			)) {
				firstHop.add(importer);
			}
			continue;
		}
		if (!impact.propagates) continue;

		const ungated =
			impact.ungated === true || impact.impactedSymbols.some(isStarReexportKey);

		for (const dependent of importGraph.dependents.get(impact.filePath) ?? []) {
			const edge = importGraph.edges.get(dependent)?.get(impact.filePath);
			if (edge === undefined) {
				// Edge metadata missing — propagate rather than under-run.
				firstHop.add(dependent);
				continue;
			}
			if (edge.dynamic) {
				notes.add(
					`${dependent}: dynamic import of ${impact.filePath} — names unknowable`,
				);
				firstHop.add(dependent);
				continue;
			}
			if (ungated || edge.names.has("*")) {
				firstHop.add(dependent);
				continue;
			}
			if (impact.impactedSymbols.some((s) => edge.names.has(s))) {
				firstHop.add(dependent);
			}
			// Otherwise: the dependent imports only untouched symbols — gated out.
		}
	}

	// Beyond the gated first hop, propagation is structural: a dependent's own
	// inferred types may shift in ways per-file analysis cannot prove stable.
	for (const file of computeAffectedFiles(firstHop, importGraph)) {
		affected.add(file);
	}

	// One note per kind, not per file: a repository importing stylesheets would
	// otherwise pin the score at its floor on every run, and say nothing.
	const unanalyzed = changed
		.filter((impact) => impact.classification === "unanalyzed")
		.map((impact) => impact.filePath);
	const outside = unanalyzed.filter(isOutsideWorkspace);
	const notTypeScript = unanalyzed.filter((file) => !isOutsideWorkspace(file));
	if (notTypeScript.length > 0) {
		const one = notTypeScript.length === 1;
		notes.add(
			`${notTypeScript.length} changed ${one ? "file is" : "files are"} not TypeScript and ${one ? "was" : "were"} not analyzed (${listPaths(notTypeScript)})`,
		);
	}
	if (outside.length > 0) {
		const one = outside.length === 1;
		notes.add(
			`${outside.length} changed ${one ? "file is" : "files are"} outside the directory variant ran in and ${one ? "was" : "were"} not analyzed (${listPaths(outside)})`,
		);
	}

	const withUnresolved = [...affected].sort().flatMap((file) => {
		const specs = importGraph.unresolved.get(file);
		return specs === undefined || specs.size === 0
			? []
			: [`${file} (${[...specs].sort().join(", ")})`];
	});
	if (withUnresolved.length > 0) {
		const one = withUnresolved.length === 1;
		notes.add(
			`${withUnresolved.length} affected ${one ? "file has" : "files have"} unresolved imports: ${listPaths(withUnresolved)}`,
		);
	}

	// Any changed file could be what such a loader loads, so this applies to
	// every prediction, not only those that touch the loader.
	if (importGraph.computed.size > 0) {
		const loaders = [...importGraph.computed].sort();
		notes.add(
			`${loaders.length} file(s) load a module through a fully computed import() or require() specifier (${listPaths(loaders)}); a change reached only that way selects no tests`,
		);
	}

	const packageDirs = options.packageDirs ?? {};
	const affectedPackages = new Set<string>();
	for (const file of affected) {
		const pkg = fileToPackage(file, packageDirs);
		if (pkg !== undefined) affectedPackages.add(pkg);
	}

	const affectedTasks: string[] = [];
	for (const taskName of Object.keys(options.tasks ?? {})) {
		const sep = taskName.lastIndexOf(":");
		if (sep === -1) continue;
		if (affectedPackages.has(taskName.slice(0, sep))) {
			affectedTasks.push(taskName);
		}
	}

	const noteList = [...notes].sort();
	const confidence = Math.max(
		0.3,
		Math.round((1 - noteList.length * 0.1) * 100) / 100,
	);

	return {
		baseRef,
		changed,
		affectedFiles: [...affected].sort(),
		affectedPackages: [...affectedPackages].sort(),
		affectedTasks: affectedTasks.sort(),
		confidence,
		notes: noteList,
	};
}

/**
 * Convert a differ result into the gate-ready impact shape. An added export is
 * normally harmless to existing importers, but an added star re-export can
 * shadow a name another star provided (two stars exporting one name make it
 * ambiguous, so neither exports it), so it counts as impacted.
 */
export function toFileImpact(result: ClassifyResult): FileImpact {
	const impactedSymbols = [
		...result.exportedSymbols.added.filter(isStarReexportKey),
		...result.exportedSymbols.removed,
		...result.exportedSymbols.changed
			.filter((c) => c.kind !== "body")
			.map((c) => c.name),
	].sort();
	// A changed star re-export changes names that cannot be listed, and a file
	// that does not parse has no trustworthy names at all.
	const ungated =
		result.syntaxErrors || impactedSymbols.some(isStarReexportKey);
	return {
		filePath: result.filePath,
		classification: result.classification,
		impactedSymbols,
		propagates: result.classification === "breaking",
		...(ungated && { ungated: true }),
		notes: result.confidenceNotes.map((n) => `${result.filePath}: ${n}`),
	};
}

/** Workspace package name -> workspace-relative POSIX dir. */
export function packageDirsFrom(
	cwd: string,
	packageGraph: PackageGraph | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pkg of packageGraph?.packages ?? []) {
		out[pkg.manifest.name] = toPosix(path.relative(cwd, pkg.dir));
	}
	return out;
}

/** Package name -> its `exports` field, for bare-import resolution. */
export function packageExportsFrom(
	packageGraph: PackageGraph | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const pkg of packageGraph?.packages ?? []) {
		if (pkg.manifest.exports !== undefined) {
			out[pkg.manifest.name] = pkg.manifest.exports;
		}
	}
	return out;
}

function listPaths(items: readonly string[]): string {
	return items.length > MAX_NOTE_FILES
		? `${items.slice(0, MAX_NOTE_FILES).join(", ")}, … ${items.length - MAX_NOTE_FILES} more`
		: items.join(", ");
}

/** Longest-prefix owner lookup: `packages/auth/src/x.ts` -> `@org/auth`. */
function fileToPackage(
	file: string,
	packageDirs: Record<string, string>,
): string | undefined {
	let bestName: string | undefined;
	let bestLength = -1;
	for (const [name, dir] of Object.entries(packageDirs)) {
		// A root package's dir is "" and owns every file no deeper package does.
		const prefix = dir === "" ? "" : `${dir}/`;
		if (file.startsWith(prefix) && prefix.length > bestLength) {
			bestName = name;
			bestLength = prefix.length;
		}
	}
	return bestName;
}

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}
