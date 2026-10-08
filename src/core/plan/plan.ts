/**
 * @module
 * The verification plan: given a change, what has to be checked before it is
 * safe to merge. Which test files, per runner; which package-level checks;
 * where the plan is wider than the import graph and why; and which parts of
 * the change nothing in the plan verifies.
 *
 * Built from the same analysis as `impact`, and planning only: variant runs
 * none of it here, and records no prediction.
 */

import path from "node:path";
import type { ImportGraph } from "../graph/import-graph.js";
import {
	computeAffectedFiles,
	importersOfUnindexed,
} from "../graph/import-graph.js";
import { pathsToward } from "../graph/import-paths.js";
import type { ImpactOptions } from "../impact/predict.js";
import { analyzeImpact } from "../impact/predict.js";
import type { BlastRadius, ImpactClass } from "../semantic/blast-radius.js";
import { packageRootOf } from "../semantic/blast-radius.js";
import { isStarReexportKey } from "../semantic/surface.js";
import type { TestImpact } from "../semantic/test-impact.js";
import {
	defaultIsTestFile,
	invalidatesAllTests,
	isJavaScriptTestFile,
	PROSE_FILE,
} from "../semantic/test-impact.js";
import type { Resolution } from "../semantic/verdict.js";
import type { PackageManagerName } from "../setup/discover.js";
import { packageManagerOf } from "../setup/discover.js";
import type { CommandStyle, PackageScripts, PlannedCheck } from "./checks.js";
import { planChecks } from "./checks.js";

export type Risk = "high" | "medium" | "low" | "none";

export interface PlannedChange {
	filePath: string;
	classification: ImpactClass;
	/** Exported names whose shape changed or that were removed. */
	symbols: string[];
	/** Files that import this one, directly or through other files. */
	dependents: number;
	/** Packages other than its own that those files are in. */
	crossesInto: string[];
	/** Test files that reach it. */
	tests: number;
	risk: Risk;
	/** The rule that set `risk`, in words. */
	reason: string;
}

export type TestRunner = "vitest" | "jest" | "unknown";

export interface PlannedTests {
	runner: TestRunner;
	/** Directory of the config these files run under; "" for the root. */
	dir: string;
	files: string[];
}

export interface Unverified {
	filePath: string;
	symbols: string[];
	/** Files importing it directly. */
	usedBy: string[];
	reason: string;
}

export interface VerificationPlan {
	baseRef: string;
	baseLabel: string;
	changes: PlannedChange[];
	tests: {
		selected: number;
		total: number;
		/** True when every test is in the plan, whatever it imports. */
		all: boolean;
		runs: PlannedTests[];
		/**
		 * Selected test -> the import chain from it to the nearest changed
		 * file. A test selected only because everything was has no entry.
		 */
		why: Record<string, string[]>;
	};
	checks: PlannedCheck[];
	/** Why the plan holds more than the import graph alone would select. */
	widened: string[];
	notVerified: Unverified[];
	/** How much of the change the graph resolved. Not a safety figure. */
	resolution: Resolution;
	notes: string[];
	repositoryNotes: string[];
}

/** Where a runner's files begin: a config, or a package that depends on it. */
export interface RunnerRoot {
	dir: string;
	runner: Exclude<TestRunner, "unknown">;
}

export interface PlanInputs {
	baseRef: string;
	baseLabel: string;
	radius: BlastRadius;
	tests: TestImpact;
	graph: ImportGraph;
	/** The root package and every workspace package. */
	packages: readonly PackageScripts[];
	runnerRoots: readonly RunnerRoot[];
	style: CommandStyle;
}

const RISK_ORDER: Record<Risk, number> = {
	high: 0,
	medium: 1,
	low: 2,
	none: 3,
};

function nearest<T extends { dir: string }>(
	file: string,
	candidates: readonly T[],
): T | undefined {
	let best: T | undefined;
	for (const candidate of candidates) {
		const inside = candidate.dir === "" || file.startsWith(`${candidate.dir}/`);
		if (
			inside &&
			(best === undefined || candidate.dir.length > best.dir.length)
		) {
			best = candidate;
		}
	}
	return best;
}

function reachOf(file: string, graph: ImportGraph): Set<string> {
	const seeds = graph.imports.has(file)
		? new Set([file])
		: importersOfUnindexed(graph, file);
	const reach = computeAffectedFiles(seeds, graph);
	reach.delete(file);
	return reach;
}

/**
 * The stated rule. In order: nothing reaches it; its shape changed for
 * another package; its shape changed, or variant could not read it, or it
 * configures every test; only its body changed and a test reaches it.
 */
function riskOf(
	change: Omit<PlannedChange, "risk" | "reason">,
	unverified: boolean,
): Pick<PlannedChange, "risk" | "reason"> {
	if (change.classification === "non-impacting") {
		return { risk: "none", reason: "comments or formatting only" };
	}
	if (PROSE_FILE.test(change.filePath)) {
		return { risk: "none", reason: "documentation" };
	}
	if (invalidatesAllTests(change.filePath)) {
		return {
			risk: "medium",
			reason: "configuration every test and build runs under",
		};
	}
	if (unverified) return { risk: "high", reason: "no test reaches it" };
	if (change.classification === "breaking" && change.crossesInto.length > 0) {
		return {
			risk: "high",
			reason: "its exports changed, and other packages import it",
		};
	}
	if (change.classification === "breaking") {
		return { risk: "medium", reason: "its exports changed" };
	}
	if (change.classification === "unanalyzed") {
		return { risk: "medium", reason: "not a file variant can read" };
	}
	return { risk: "low", reason: "implementation only, and tests reach it" };
}

export function assemblePlan(inputs: PlanInputs): VerificationPlan {
	const { radius, tests, graph } = inputs;
	const packageDirs = inputs.packages.map((pkg) => pkg.dir);
	const nameOf = new Map(
		inputs.packages.map((pkg) => [pkg.dir, pkg.name ?? pkg.dir]),
	);
	const isTest = (file: string): boolean =>
		graph.imports.has(file) && defaultIsTestFile(file);
	const unselected = new Set(tests.unselectedTests);
	const unverifiedFiles = new Set<string>();

	const changes = radius.changed.map((impact): PlannedChange => {
		const reach = reachOf(impact.filePath, graph);
		const home = packageRootOf(impact.filePath, packageDirs);
		const crossesInto = new Set<string>();
		let reaching = isTest(impact.filePath) ? 1 : 0;
		for (const file of reach) {
			if (isTest(file)) reaching++;
			const dir = packageRootOf(file, packageDirs);
			if (dir !== home) crossesInto.add(nameOf.get(dir) ?? dir);
		}
		const facts = {
			filePath: impact.filePath,
			classification: impact.classification,
			symbols: impact.impactedSymbols.filter(
				(name) => !isStarReexportKey(name),
			),
			dependents: reach.size,
			crossesInto: [...crossesInto].sort(),
			tests: reaching,
		};
		// Asked of every change, select-all included: running every test
		// verifies nothing about a file that none of them imports. A deleted
		// file nothing imports is dead code going away, not a gap.
		const deleted =
			impact.classification !== "unanalyzed" &&
			!graph.imports.has(impact.filePath);
		const unverified =
			unselected.has(impact.filePath) || (reaching === 0 && !deleted);
		const scored = riskOf(facts, unverified);
		if (scored.risk === "high" && unverified) {
			unverifiedFiles.add(impact.filePath);
		}
		return { ...facts, ...scored };
	});
	changes.sort(
		(a, b) =>
			RISK_ORDER[a.risk] - RISK_ORDER[b.risk] ||
			a.filePath.localeCompare(b.filePath),
	);

	const seeds = radius.changed
		.filter((impact) => impact.classification !== "non-impacting")
		.map((impact) => impact.filePath);
	const chainFrom = pathsToward(graph, seeds);
	const why: Record<string, string[]> = {};
	const runs = new Map<string, PlannedTests>();
	for (const test of tests.affectedTests) {
		const chain = chainFrom(test);
		if (chain !== null) why[test] = chain;
		const root = nearest(test, inputs.runnerRoots);
		const run: PlannedTests = {
			runner: root?.runner ?? "unknown",
			dir: root?.dir ?? "",
			files: [],
		};
		const key = `${run.runner}\0${run.dir}`;
		const existing = runs.get(key) ?? run;
		existing.files.push(test);
		runs.set(key, existing);
	}

	const widened: string[] = [];
	for (const impact of radius.changed) {
		if (invalidatesAllTests(impact.filePath)) {
			widened.push(
				`${impact.filePath} changed: every test and every package's checks are in the plan, because it configures all of them`,
			);
		} else if (
			impact.ungated === true ||
			impact.impactedSymbols.some(isStarReexportKey)
		) {
			widened.push(
				`${impact.filePath}: every file importing it is affected, whichever names it takes, because the file does not parse or re-exports with \`export *\``,
			);
		}
	}

	const affectedDirs = new Set(
		radius.affectedFiles.map((file) => packageRootOf(file, packageDirs)),
	);
	const checked = inputs.packages.filter(
		(pkg) => tests.selectAll || affectedDirs.has(pkg.dir),
	);

	const notVerified = radius.changed
		.filter((impact) => unverifiedFiles.has(impact.filePath))
		.map((impact): Unverified => {
			const direct = graph.imports.has(impact.filePath)
				? (graph.dependents.get(impact.filePath) ?? [])
				: importersOfUnindexed(graph, impact.filePath);
			return {
				filePath: impact.filePath,
				symbols: impact.impactedSymbols.filter(
					(name) => !isStarReexportKey(name),
				),
				usedBy: [...direct].sort(),
				reason: isJavaScriptTestFile(impact.filePath)
					? "a changed test in JavaScript, which variant does not index: run it yourself"
					: "no test reaches it: it is untested, or used in a way variant cannot follow",
			};
		});

	return {
		baseRef: inputs.baseRef,
		baseLabel: inputs.baseLabel,
		changes,
		tests: {
			selected: tests.affectedTests.length,
			total: tests.totalTests,
			all: tests.selectAll,
			runs: [...runs.values()].sort(
				(a, b) =>
					a.dir.localeCompare(b.dir) || a.runner.localeCompare(b.runner),
			),
			why,
		},
		checks: planChecks(checked, inputs.style),
		widened,
		notVerified,
		resolution: tests.resolution,
		notes: [...radius.notes, ...tests.notes],
		repositoryNotes: [...radius.repositoryNotes, ...tests.repositoryNotes],
	};
}

const RUNNER_CONFIGS: ReadonlyArray<[RegExp, RunnerRoot["runner"]]> = [
	[/^vitest\.(?:config|workspace|projects)\./, "vitest"],
	[/^jest\.config\./, "jest"],
];

async function findRunnerRoots(cwd: string): Promise<RunnerRoot[]> {
	const fg = (await import("fast-glob")).default;
	const found = await fg(
		["**/vitest.{config,workspace,projects}.*", "**/jest.config.*"],
		{
			cwd,
			onlyFiles: true,
			ignore: ["**/node_modules/**", "**/dist/**", ".git/**", ".variant/**"],
		},
	);
	const roots: RunnerRoot[] = [];
	for (const file of found.map((entry) => entry.replace(/\\/g, "/")).sort()) {
		const name = path.posix.basename(file);
		const runner = RUNNER_CONFIGS.find(([pattern]) => pattern.test(name))?.[1];
		if (runner === undefined) continue;
		const dir = path.posix.dirname(file);
		roots.push({ dir: dir === "." ? "" : dir, runner });
	}
	return roots;
}

async function taskRunnerOf(cwd: string): Promise<CommandStyle["taskRunner"]> {
	const { access } = await import("node:fs/promises");
	const exists = (file: string): Promise<boolean> =>
		access(path.join(cwd, file)).then(
			() => true,
			() => false,
		);
	if (await exists("turbo.json")) return "turborepo";
	return (await exists("nx.json")) ? "nx" : null;
}

interface ScriptsManifest {
	name?: string;
	scripts?: Record<string, string>;
}

async function readRootPackage(cwd: string): Promise<PackageScripts | null> {
	const { readFile } = await import("node:fs/promises");
	try {
		const manifest = JSON.parse(
			await readFile(path.join(cwd, "package.json"), "utf8"),
		) as ScriptsManifest;
		return { name: manifest.name, dir: "", scripts: manifest.scripts ?? {} };
	} catch {
		return null;
	}
}

export async function buildVerificationPlan(
	cwd: string,
	options: ImpactOptions = {},
): Promise<VerificationPlan> {
	const [{ base, result, packageGraph }, runnerRoots, root, manager, runner] =
		await Promise.all([
			analyzeImpact(cwd, options),
			findRunnerRoots(cwd),
			readRootPackage(cwd),
			packageManagerOf(cwd),
			taskRunnerOf(cwd),
		]);
	const style: {
		packageManager: PackageManagerName | null;
		taskRunner: CommandStyle["taskRunner"];
	} = { packageManager: manager, taskRunner: runner };

	const packages: PackageScripts[] = root === null ? [] : [root];
	for (const pkg of packageGraph?.packages ?? []) {
		const dir = path.relative(cwd, pkg.dir).replace(/\\/g, "/");
		if (dir === "") continue;
		packages.push({
			name: pkg.manifest.name,
			dir,
			scripts: pkg.manifest.scripts ?? {},
		});
	}

	return assemblePlan({
		baseRef: base.ref,
		baseLabel: base.label,
		radius: result.radius,
		tests: result.tests,
		graph: result.graph,
		packages,
		runnerRoots,
		style,
	});
}
