/**
 * @module
 * Test impact analysis. Maps test
 * files to the source they import (reusing the file-level import graph) and
 * selects the tests whose import closure intersects the blast radius:
 * *run 32 tests instead of 10,000.*
 *
 * Selection is about runtime behavior, so it is deliberately wider than the
 * build-oriented gating in `blast-radius.ts`: a body-only edit still selects
 * every test that transitively imports the file — implementation changes
 * change behavior. The semantic wins over plain `vitest related` /
 * `jest --findRelatedTests` are (a) `non-impacting` changes (comments,
 * whitespace, formatting) select zero tests, and (b) closures cross package
 * boundaries in a monorepo via the workspace-resolved import graph.
 *
 * Honest scoping: static import closure misses fixtures, snapshots, setup
 * files, and non-TS assets. These lower the confidence score rather than
 * being ignored, and build/test config changes trigger a select-all instead
 * of an unsafe narrow.
 */

import type { ImportGraph } from "../graph/import-graph.js";
import {
	buildImportGraph,
	importersOfUnindexed,
} from "../graph/import-graph.js";
import { readPathAliases } from "../graph/tsconfig-paths.js";
import type { BlastRadius, TraceBlastRadiusOptions } from "./blast-radius.js";
import {
	packageDirsFrom,
	packageExportsFrom,
	traceBlastRadius,
} from "./blast-radius.js";
import { updateSymbolGraph } from "./symbol-graph.js";
import type { Resolution } from "./verdict.js";
import { resolutionOf } from "./verdict.js";

/** test file -> every workspace file in its static import closure (incl. itself). */
export interface TestTrace {
	closures: ReadonlyMap<string, ReadonlySet<string>>;
}

/** source file -> test files whose import closure contains it. */
export interface CoverageMap {
	testsFor: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface TestImpact {
	/** Tests to run, sorted. Equals every known test when `selectAll` is true. */
	affectedTests: string[];
	totalTests: number;
	/** True when narrowing is unsafe (build/test configuration changed). */
	selectAll: boolean;
	/**
	 * Changed files the index does not cover (not TypeScript) that no test
	 * imports, directly or through an importer. They select nothing, and that
	 * is a blind spot rather than a finding, so it is reported on its own.
	 */
	unreached: string[];
	/**
	 * How much of this change the graph resolved: the blast radius's score,
	 * lowered by closure blind spots. 1 when every test is selected, since
	 * nothing is then left to a graph that might be wrong.
	 */
	confidence: number;
	/** `confidence` bucketed; see `resolutionOf`. */
	resolution: Resolution;
	/** What could not be resolved about this change. */
	notes: string[];
	/** Standing gaps, the same whatever changed. See `BlastRadius`. */
	repositoryNotes: string[];
}

export interface TestImpactOptions {
	/** Override test-file detection. Default: `*.test.*` / `*.spec.*` / `__tests__/`. */
	isTestFile?: (file: string) => boolean;
}

export function defaultIsTestFile(file: string): boolean {
	return (
		/(^|\/)__tests__\//.test(file) ||
		/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(file)
	);
}

/**
 * Changed files that invalidate every test regardless of imports: dependency
 * manifests, lockfiles and the package-manager config that decides what is
 * installed and how it is laid out, TS config, test-runner config, and the
 * setup files a runner loads before every test. Tests never import a setup file, so its
 * change would otherwise select nothing. Matched by path alone: a `.ts` config
 * classifies as ordinary code, and gating on `unanalyzed` once let every
 * `vitest.config.ts` edit select zero tests. A setup file with an
 * unconventional name is still missed.
 */
const TEST_CONFIG_FILE =
	/(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json|(vitest|jest|playwright|vite|babel|next)\.config\.[^/.]+(\.[^/]+)?|vitest\.(workspace|projects)\.[^/.]+|\.babelrc(\.[^/]+)?)$/;

const TEST_SETUP_FILE =
	/(^|\/)((vitest|jest)\.setup|setup-?tests|global-?(setup|teardown)|tests?\/setup)\.[cm]?[jt]sx?$/i;

/**
 * Prose is left out of `unreached`: no test imports a README, and a warning
 * that fires on every documentation edit is one people learn to skip. This
 * only quiets the warning; it selects nothing either way.
 */
const PROSE_FILE = /\.(?:md|markdown|rst|txt|adoc)$/i;

function invalidatesAllTests(filePath: string): boolean {
	return TEST_CONFIG_FILE.test(filePath) || TEST_SETUP_FILE.test(filePath);
}

/** Forward-BFS each test file's import closure. */
export function buildTestTrace(
	graph: ImportGraph,
	options: TestImpactOptions = {},
): TestTrace {
	const isTest = options.isTestFile ?? defaultIsTestFile;
	const closures = new Map<string, ReadonlySet<string>>();
	for (const file of [...graph.imports.keys()].sort()) {
		if (isTest(file)) closures.set(file, closureOf(file, graph));
	}
	return { closures };
}

/** Invert a TestTrace: which tests cover each source file. */
export function buildCoverageMap(trace: TestTrace): CoverageMap {
	const testsFor = new Map<string, Set<string>>();
	for (const [test, closure] of trace.closures) {
		for (const file of closure) {
			let tests = testsFor.get(file);
			if (tests === undefined) {
				tests = new Set();
				testsFor.set(file, tests);
			}
			tests.add(test);
		}
	}
	return { testsFor };
}

/**
 * Select the tests whose import closure intersects the blast radius. Because
 * closures include the test file itself, a changed test always selects
 * itself, and any file in `affectedFiles` selects every test that reaches it.
 */
export function computeTestImpact(
	radius: Pick<BlastRadius, "changed" | "affectedFiles" | "confidence">,
	graph: ImportGraph,
	options: TestImpactOptions = {},
): TestImpact {
	const trace = buildTestTrace(graph, options);
	const coverage = buildCoverageMap(trace);
	const allTests = [...trace.closures.keys()];
	const notes = new Set<string>();

	let selectAll = false;
	for (const impact of radius.changed) {
		if (invalidatesAllTests(impact.filePath)) {
			selectAll = true;
			notes.add(
				`${impact.filePath}: build/test configuration changed — running all tests`,
			);
		}
	}

	const affected = new Set<string>();
	if (selectAll) {
		for (const test of allTests) affected.add(test);
	} else {
		for (const file of radius.affectedFiles) {
			for (const test of coverage.testsFor.get(file) ?? []) {
				affected.add(test);
			}
		}
	}

	const unreached: string[] = [];
	if (!selectAll) {
		for (const impact of radius.changed) {
			if (impact.classification !== "unanalyzed") continue;
			if (PROSE_FILE.test(impact.filePath)) continue;
			// Closures are transitive, so a test reaching any dependent of an
			// importer also reaches the importer itself.
			const reached = [...importersOfUnindexed(graph, impact.filePath)].some(
				(importer) => (coverage.testsFor.get(importer)?.size ?? 0) > 0,
			);
			if (!reached) unreached.push(impact.filePath);
		}
	}

	// Static closures cannot see fixtures, snapshots, or non-TS assets; count
	// the selected tests whose closure has unresolved imports as one signal.
	let blindSpots = 0;
	for (const test of affected) {
		const closure = trace.closures.get(test);
		if (closure === undefined) continue;
		for (const file of closure) {
			const unresolvedForFile = graph.unresolved.get(file);
			if (unresolvedForFile !== undefined && unresolvedForFile.size > 0) {
				blindSpots++;
				break;
			}
		}
	}
	if (blindSpots > 0) {
		notes.add(
			`${blindSpots} selected test file(s) have unresolved imports in their closure — fixtures or assets may be missed`,
		);
	}

	const noteList = [...notes].sort();
	const confidence = selectAll
		? 1
		: Math.max(
				0.3,
				Math.round((radius.confidence - noteList.length * 0.1) * 100) / 100,
			);

	return {
		affectedTests: [...affected].sort(),
		totalTests: allTests.length,
		selectAll,
		unreached,
		confidence,
		resolution: resolutionOf(confidence),
		notes: noteList,
		repositoryNotes: [],
	};
}

export interface TestImpactResult {
	radius: BlastRadius;
	tests: TestImpact;
}

/**
 * Full pipeline: blast radius (1.3) plus test impact, sharing one incremental
 * symbol-graph update. Returns null when the changed set is unavailable,
 * mirroring `traceBlastRadius`.
 */
export async function traceTestImpact(
	cwd: string,
	options: TraceBlastRadiusOptions & TestImpactOptions = {},
): Promise<TestImpactResult | null> {
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
			packageDirs: packageDirsFrom(cwd, options.packageGraph),
			pathAliases,
			packageExports: packageExportsFrom(options.packageGraph),
		});
	}

	const radius = await traceBlastRadius(cwd, { ...options, importGraph });
	if (radius === null) return null;

	return {
		radius,
		tests: computeTestImpact(
			radius,
			importGraph,
			options.isTestFile === undefined
				? {}
				: { isTestFile: options.isTestFile },
		),
	};
}

function closureOf(start: string, graph: ImportGraph): ReadonlySet<string> {
	const closure = new Set<string>([start]);
	let frontier = new Set<string>([start]);
	while (frontier.size > 0) {
		const next = new Set<string>();
		for (const file of frontier) {
			for (const target of graph.imports.get(file) ?? []) {
				if (!closure.has(target)) {
					closure.add(target);
					next.add(target);
				}
			}
		}
		frontier = next;
	}
	return closure;
}
