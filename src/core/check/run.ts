/**
 * @module
 * `variant check`: mutate the changed lines and report what the tests did not
 * notice. This module decides what to mutate and when to stop; the engine
 * that mutates and runs the tests sits behind {@link MutationBackend}.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
	BaselineFailedError,
	CheckBackendError,
	CheckRunnerError,
	CheckWorkspaceRootError,
	GitRefError,
} from "../errors.js";
import { mapLimit } from "../execution/concurrency.js";
import { createClassifier } from "../semantic/differ.js";
import type { ProgramComparer } from "../semantic/equivalence.js";
import { createProgramComparer } from "../semantic/equivalence.js";
import { defaultIsTestFile } from "../semantic/test-impact.js";
import { assertBaseRef } from "../vcs/base-ref.js";
import { changeBaseDeps } from "../vcs/change-base.js";
import {
	hasLocalChanges,
	listChangedFiles,
	listUntrackedFiles,
	readFileAtRef,
	readZeroContextDiff,
} from "../vcs/git.js";
import type {
	BackendEvent,
	BaselineTest,
	MutationBackend,
	PlannedMutant,
	TestedMutant,
} from "./backend.js";
import type { CheckBase } from "./base.js";
import { resolveCheckBase } from "./base.js";
import type { FileHunks } from "./hunks.js";
import { parseZeroContextDiff } from "./hunks.js";
import type { CheckResult, StopReason } from "./result.js";
import { assembleCheckResult } from "./result.js";
import type { RunnerVerdict } from "./runner.js";
import { detectRunner } from "./runner.js";
import type { Selection } from "./selection.js";
import { selectMutants } from "./selection.js";
import type { SymbolLookup } from "./symbols.js";
import { createSymbolReader } from "./symbols.js";
import {
	exclusionBeforeDiff,
	isNewSource,
	mutateEntries,
	selectTargets,
} from "./targets.js";

export interface CheckOptions {
	base?: string;
	maxMutants: number;
	/** Wall-clock limit for the whole run, the baseline included. */
	budgetMs: number;
	vitestConfig?: string;
	signal?: AbortSignal;
}

export const DEFAULT_MAX_MUTANTS = 50;
export const DEFAULT_BUDGET_MS = 5 * 60_000;

/** Everything with an effect, so the flow can be tested without git or tests. */
export interface CheckDeps {
	backend: MutationBackend;
	now: () => number;
	resolveBase: (explicit: string | undefined) => Promise<CheckBase>;
	assertBase: (ref: string) => Promise<void>;
	listChangedFiles: (ref: string) => Promise<string[] | null>;
	listUntrackedFiles: () => Promise<string[] | null>;
	readDiff: (ref: string, file: string) => Promise<string | null>;
	readFile: (file: string) => Promise<string | null>;
	/** A file as it was at `ref`; null when it did not exist there. */
	readFileAtBase: (ref: string, file: string) => Promise<string | null>;
	/** Whether a change to a file is only formatting or comments. */
	isFormattingOnly: (
		file: string,
		before: string,
		after: string,
	) => Promise<boolean>;
	isWorkspaceRoot: () => Promise<boolean>;
	detectRunner: () => Promise<RunnerVerdict>;
	symbols?: (
		file: string,
		content: string,
	) => Promise<SymbolLookup | undefined>;
}

async function readText(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * Whether these files declare workspace packages. Declared only: package
 * discovery elsewhere guesses `packages/*` when nothing is declared, which
 * would make a single package with such a folder look like a root. And a
 * `pnpm-workspace.yaml` alone is not one: pnpm 10 keeps its settings there.
 */
export function declaresWorkspaces(
	pnpmWorkspace: string | null,
	manifest: string | null,
): boolean {
	if (pnpmWorkspace !== null && /^packages\s*:/m.test(pnpmWorkspace)) {
		return true;
	}
	if (manifest === null) return false;
	try {
		const parsed = JSON.parse(manifest) as { workspaces?: unknown };
		return parsed.workspaces !== undefined;
	} catch {
		return false;
	}
}

async function isWorkspaceRoot(cwd: string): Promise<boolean> {
	const [pnpmWorkspace, manifest] = await Promise.all([
		readText(path.join(cwd, "pnpm-workspace.yaml")),
		readText(path.join(cwd, "package.json")),
	]);
	return declaresWorkspaces(pnpmWorkspace, manifest);
}

/**
 * The differ, then the tree comparer: the differ reads tokens and calls a
 * dropped pair of redundant parentheses a change; the comparer reads the
 * tree and does not. Either saying "no change" is enough.
 */
function formattingOnly(
	classify: ReturnType<typeof createClassifier>,
	sameProgram: ProgramComparer,
): CheckDeps["isFormattingOnly"] {
	return async (filePath, before, after) =>
		(await classify({ filePath, before, after })).classification ===
			"non-impacting" || (await sameProgram(filePath, before, after));
}

export function checkDeps(cwd: string, backend: MutationBackend): CheckDeps {
	return {
		backend,
		now: () => Date.now(),
		resolveBase: (explicit) =>
			resolveCheckBase(explicit, {
				...changeBaseDeps(cwd),
				hasLocalChanges: () => hasLocalChanges(cwd),
			}),
		assertBase: (ref) => assertBaseRef(cwd, ref),
		listChangedFiles: (ref) => listChangedFiles(cwd, ref),
		listUntrackedFiles: () => listUntrackedFiles(cwd),
		readDiff: (ref, file) => readZeroContextDiff(cwd, ref, file),
		readFile: (file) => readText(path.join(cwd, file)),
		readFileAtBase: (ref, file) => readFileAtRef(cwd, ref, file),
		isFormattingOnly: formattingOnly(
			createClassifier(),
			createProgramComparer(),
		),
		isWorkspaceRoot: () => isWorkspaceRoot(cwd),
		detectRunner: async () =>
			detectRunner(
				await readText(path.join(cwd, "package.json")),
				await readdir(cwd).catch(() => []),
			),
		symbols: createSymbolReader(),
	};
}

function digest(text: string | null): string {
	return createHash("sha256")
		.update(text ?? "\0missing")
		.digest("hex");
}

type Next<T> = IteratorResult<T> | "budget" | "interrupted";

/** The next event, or why the run must stop before it arrives. */
function nextOrStop<T>(
	iterator: AsyncIterator<T>,
	msLeft: number,
	signal: AbortSignal | undefined,
): Promise<Next<T>> {
	if (signal?.aborted === true) return Promise.resolve("interrupted");
	if (msLeft <= 0) return Promise.resolve("budget");
	return new Promise<Next<T>>((resolve, reject) => {
		const timer = setTimeout(() => finish("budget"), msLeft);
		const onAbort = (): void => finish("interrupted");
		signal?.addEventListener("abort", onAbort, { once: true });
		function finish(value: Next<T>): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		}
		iterator.next().then(finish, (error: unknown) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}

export async function runCheck(
	cwd: string,
	options: CheckOptions,
	deps: CheckDeps,
): Promise<CheckResult> {
	const startedAt = deps.now();
	const base = await deps.resolveBase(options.base);
	await deps.assertBase(base.ref);
	if (await deps.isWorkspaceRoot()) throw new CheckWorkspaceRootError();
	if (options.vitestConfig === undefined) {
		const runner = await deps.detectRunner();
		if (runner.kind !== "vitest") throw new CheckRunnerError(runner);
	}

	const [changed, untracked] = await Promise.all([
		deps.listChangedFiles(base.ref),
		deps.listUntrackedFiles(),
	]);
	if (changed === null || untracked === null) {
		throw new GitRefError(
			`Could not compare the working tree with ${base.ref}`,
		);
	}

	const mutable = (file: string): boolean =>
		exclusionBeforeDiff(file, defaultIsTestFile) === null;
	const hunks = new Map<string, FileHunks>();
	const formatting = new Set<string>();
	// What each file held when it was read here: classified, then quoted in
	// the report. One read, so the two cannot disagree.
	const contents = new Map<string, string>();
	await mapLimit(changed.filter(mutable), 8, async (file) => {
		const diff = await deps.readDiff(base.ref, file);
		if (diff === null) return;
		const fileHunks = parseZeroContextDiff(diff);
		hunks.set(file, fileHunks);
		if (fileHunks.added.length === 0) return;
		// The semantic differ already tells a reformat from a change; without
		// it a formatting commit read as findings on untouched behaviour.
		const [before, after] = await Promise.all([
			deps.readFileAtBase(base.ref, file),
			deps.readFile(file),
		]);
		if (after !== null) contents.set(file, after);
		if (
			before !== null &&
			after !== null &&
			(await deps.isFormattingOnly(file, before, after).catch(() => false))
		) {
			formatting.add(file);
		}
	});
	// A new file git does not track yet is all new lines.
	const newFiles = untracked.filter(
		(file) => isNewSource(file) && mutable(file),
	);
	await mapLimit(newFiles, 8, async (file) => {
		const content = await deps.readFile(file);
		if (content === null) return;
		contents.set(file, content);
		const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
		if (lines > 0) {
			hunks.set(file, { added: [{ start: 1, end: lines }], deletedLines: 0 });
		}
	});
	const { targets, excluded, deletedLines } = selectTargets({
		changed,
		untracked,
		hunks,
		formattingOnly: formatting,
		isTestFile: defaultIsTestFile,
	});

	const assembleBase = {
		base,
		targets,
		excluded,
		deletedLines,
		...(options.vitestConfig !== undefined && {
			vitestConfig: options.vitestConfig,
		}),
	};
	if (targets.length === 0) {
		return assembleCheckResult({
			...assembleBase,
			tested: new Map(),
			snapshot: new Map(),
			durationMs: deps.now() - startedAt,
		});
	}

	const snapshot = new Map<string, string>();
	await Promise.all(
		targets.map(async (target) => {
			snapshot.set(
				target.file,
				contents.get(target.file) ?? (await deps.readFile(target.file)) ?? "",
			);
		}),
	);
	const symbols = new Map<string, SymbolLookup>();
	if (deps.symbols !== undefined) {
		for (const [file, content] of snapshot) {
			const lookup = await deps.symbols(file, content).catch(() => undefined);
			if (lookup !== undefined) symbols.set(file, lookup);
		}
	}

	const deadline = startedAt + options.budgetMs;
	const run = deps.backend.start({
		cwd,
		mutate: mutateEntries(targets),
		...(options.vitestConfig !== undefined && {
			vitestConfig: options.vitestConfig,
		}),
		// The engine's own limit on the baseline, kept inside the budget so
		// that the budget is what stops a slow one, with a reason.
		baselineTimeoutMinutes: Math.max(1, Math.ceil(options.budgetMs / 60_000)),
	});

	let baselineTests: BaselineTest[] | undefined;
	let plan: PlannedMutant[] | undefined;
	let coverageMeasured = true;
	let selection: Selection | undefined;
	const tested = new Map<string, TestedMutant>();
	let stopReason: StopReason | undefined;
	let failure: BackendEvent | undefined;
	const engineNotes: string[] = [];

	const countedDone = (): boolean =>
		selection !== undefined &&
		[...selection.selected, ...selection.free].every((id) => tested.has(id));

	const iterator = run.events[Symbol.asyncIterator]();
	try {
		for (;;) {
			const next = await nextOrStop(
				iterator,
				deadline - deps.now(),
				options.signal,
			);
			if (next === "budget" || next === "interrupted") {
				stopReason = next;
				break;
			}
			if (next.done === true) break;
			const event = next.value;
			if (event.kind === "baseline") baselineTests = event.tests;
			else if (event.kind === "plan") {
				plan = event.mutants;
				coverageMeasured = event.coverageMeasured;
				selection = selectMutants(plan, options.maxMutants);
			} else if (event.kind === "tested")
				tested.set(event.mutant.id, event.mutant);
			else if (event.kind === "note") engineNotes.push(event.text);
			else if (event.kind === "finished") break;
			else {
				failure = event;
				break;
			}
			if (countedDone() && selection !== undefined) {
				if (selection.overLimit.length > 0) stopReason = "limit";
				break;
			}
		}
	} finally {
		await run.stop();
	}

	// An interrupt reaches the engine's processes too on Windows, and they
	// die with it; that is the interrupt, not an engine failure.
	if (options.signal?.aborted === true) stopReason = "interrupted";
	else if (failure?.kind === "baseline-failed") {
		throw new BaselineFailedError(failure.failingTests, failure.output);
	} else if (failure?.kind === "error") {
		throw new CheckBackendError(failure.message, failure.output);
	} else if (stopReason === undefined && plan === undefined) {
		throw new CheckBackendError(
			"The mutation-testing engine stopped without a result",
			"",
		);
	}

	const notes: string[] = [...engineNotes];
	await Promise.all(
		targets.map(async (target) => {
			const now = await deps.readFile(target.file);
			if (digest(now) !== digest(snapshot.get(target.file) ?? null)) {
				notes.push(
					`${target.file} changed while variant check ran; the report quotes it as it was when the run started.`,
				);
			}
		}),
	);

	return assembleCheckResult({
		...assembleBase,
		...(baselineTests !== undefined && { baselineTests }),
		...(plan !== undefined && { plan }),
		...(selection !== undefined && { selection }),
		tested,
		coverageMeasured,
		...(stopReason !== undefined && { stopReason }),
		snapshot,
		symbols,
		notes: notes.sort(),
		durationMs: deps.now() - startedAt,
	});
}
