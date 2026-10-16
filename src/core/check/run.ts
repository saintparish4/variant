/**
 * @module
 * `variant check`: mutate the changed lines and report what the tests did not
 * notice. This module decides what to mutate and when to stop; the engine
 * that mutates and runs the tests sits behind {@link MutationBackend}.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	BaselineFailedError,
	CheckBackendError,
	CheckWorkspaceRootError,
	GitRefError,
} from "../errors.js";
import { mapLimit } from "../execution/concurrency.js";
import { defaultIsTestFile } from "../semantic/test-impact.js";
import { assertBaseRef } from "../vcs/base-ref.js";
import { changeBaseDeps } from "../vcs/change-base.js";
import {
	hasTrackedChanges,
	listChangedFiles,
	listUntrackedFiles,
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
import type { Selection } from "./selection.js";
import { selectMutants } from "./selection.js";
import type { SymbolLookup } from "./symbols.js";
import { createSymbolReader } from "./symbols.js";
import {
	exclusionBeforeDiff,
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
	isWorkspaceRoot: () => Promise<boolean>;
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

export function checkDeps(cwd: string, backend: MutationBackend): CheckDeps {
	return {
		backend,
		now: () => Date.now(),
		resolveBase: (explicit) =>
			resolveCheckBase(explicit, {
				...changeBaseDeps(cwd),
				hasTrackedChanges: () => hasTrackedChanges(cwd),
			}),
		assertBase: (ref) => assertBaseRef(cwd, ref),
		listChangedFiles: (ref) => listChangedFiles(cwd, ref),
		listUntrackedFiles: () => listUntrackedFiles(cwd),
		readDiff: (ref, file) => readZeroContextDiff(cwd, ref, file),
		readFile: (file) => readText(path.join(cwd, file)),
		isWorkspaceRoot: () => isWorkspaceRoot(cwd),
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

	const [changed, untracked] = await Promise.all([
		deps.listChangedFiles(base.ref),
		deps.listUntrackedFiles(),
	]);
	if (changed === null || untracked === null) {
		throw new GitRefError(
			`Could not compare the working tree with ${base.ref}`,
		);
	}

	const toDiff = changed.filter(
		(file) => exclusionBeforeDiff(file, defaultIsTestFile) === null,
	);
	const hunks = new Map<string, FileHunks>();
	await mapLimit(toDiff, 8, async (file) => {
		const diff = await deps.readDiff(base.ref, file);
		if (diff !== null) hunks.set(file, parseZeroContextDiff(diff));
	});
	const { targets, excluded, deletedLines } = selectTargets({
		changed,
		untracked,
		hunks,
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
			snapshot.set(target.file, (await deps.readFile(target.file)) ?? "");
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
	let selection: Selection | undefined;
	const tested = new Map<string, TestedMutant>();
	let stopReason: StopReason | undefined;
	let failure: BackendEvent | undefined;

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
				selection = selectMutants(plan, options.maxMutants);
			} else if (event.kind === "tested")
				tested.set(event.mutant.id, event.mutant);
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

	const notes: string[] = [];
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
		...(stopReason !== undefined && { stopReason }),
		snapshot,
		symbols,
		notes: notes.sort(),
		durationMs: deps.now() - startedAt,
	});
}
