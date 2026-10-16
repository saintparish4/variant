/**
 * @module
 * The {@link MutationBackend} behind `variant check`: StrykerJS, run in a
 * host process of its own so that a run can be stopped part-way, which
 * Stryker itself cannot do.
 *
 * Everything Stryker writes goes under `.variant/check-tmp/`, and this module
 * removes it, the run's processes included, whichever way the run ends.
 */

import type { ChildProcess } from "node:child_process";
import { fork, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BackendEvent,
	BackendRequest,
	BackendRun,
	BaselineTest,
	MutantStatus,
	MutationBackend,
	PlannedMutant,
	TestedMutant,
} from "../../core/check/backend.js";
import type { FailingTest } from "../../core/errors.js";
import type {
	HostMessage,
	HostRequest,
	RawPlannedMutant,
	RawTest,
	RawTestedMutant,
} from "./protocol.js";
import { EXCLUDED_MUTATORS } from "./protocol.js";

/**
 * Stryker still plans a mutant of an excluded mutator, as Ignored. Leaving a
 * mutator out is variant's choice, not something to report, so those are
 * dropped here and only a user's own ignore comments show as ignored.
 */
const EXCLUDED = new Set(EXCLUDED_MUTATORS);

export interface StrykerBackendOptions {
	/** The host script; defaults to the built `stryker-host.js` beside this file. */
	hostPath?: string;
	/** variant's plugins; defaults to the built `stryker-plugins.js`. */
	pluginsPath?: string;
	/** Node flags for the host, e.g. a TypeScript loader in tests. */
	execArgv?: string[];
}

const OUTPUT_LINES = 200;
const KILL_WAIT_MS = 5_000;
export const CHECK_TMP = path.join(".variant", "check-tmp");

// ------------------------------------------------------------ translation

function toPosix(file: string): string {
	return file.replace(/\\/g, "/");
}

/**
 * The project directory as given, then as its real path. Stryker names files
 * by their real path, and on macOS a temp dir under /var is a link to
 * /private/var: made relative to the link, every file read as `../…`.
 */
export function projectRoots(cwd: string): string[] {
	try {
		const real = realpathSync(cwd);
		return real === cwd ? [cwd] : [cwd, real];
	} catch {
		return [cwd];
	}
}

function relativeFile(roots: readonly string[], fileName: string): string {
	for (const root of roots) {
		const relative = path.relative(root, fileName);
		if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
			return toPosix(relative);
		}
	}
	return toPosix(path.relative(roots[0] ?? "", fileName));
}

/** Stryker's plan positions are 0-based; the port's are 1-based. */
export function toPlannedMutant(
	roots: readonly string[],
	raw: RawPlannedMutant,
): PlannedMutant {
	return {
		id: raw.id,
		file: relativeFile(roots, raw.fileName),
		mutator: raw.mutatorName,
		replacement: raw.replacement,
		start: {
			line: raw.location.start.line + 1,
			column: raw.location.start.column + 1,
		},
		end: {
			line: raw.location.end.line + 1,
			column: raw.location.end.column + 1,
		},
		covered: (raw.coveredBy?.length ?? 0) > 0,
		static: raw.static === true,
	};
}

const STATUSES = new Set<MutantStatus>([
	"Killed",
	"Survived",
	"NoCoverage",
	"Timeout",
	"RuntimeError",
	"CompileError",
	"Ignored",
	"Pending",
]);

export function toTestedMutant(raw: RawTestedMutant): TestedMutant {
	const status = STATUSES.has(raw.status as MutantStatus)
		? (raw.status as MutantStatus)
		: "RuntimeError";
	return {
		id: raw.id,
		status,
		...(raw.statusReason !== undefined && { statusReason: raw.statusReason }),
		killedBy: raw.killedBy ?? [],
		...(raw.testsCompleted !== undefined && {
			testsCompleted: raw.testsCompleted,
		}),
	};
}

export function toBaselineTest(
	roots: readonly string[],
	raw: RawTest,
): BaselineTest {
	return {
		id: raw.id,
		name: raw.name,
		file:
			raw.fileName === undefined
				? (raw.id.split("#")[0] ?? "")
				: relativeFile(roots, raw.fileName),
	};
}

// Built from the code, since a literal escape in a regex reads as a typo.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The failing tests Stryker logs under "One or more tests failed in the
 * initial test run:": a tab and the test's name, then two tabs and its
 * message. Its error says only that tests failed.
 */
export function parseFailingTests(output: string): FailingTest[] {
	const lines = output.replace(ANSI, "").split(/\r?\n/);
	const start = lines.findIndex((line) =>
		/tests failed in the initial test run:\s*$/i.test(line),
	);
	if (start === -1) return [];
	const tests: FailingTest[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\t\t/.test(line)) {
			const last = tests[tests.length - 1];
			if (last !== undefined) {
				last.message =
					last.message === "" ? line.trim() : `${last.message} ${line.trim()}`;
			}
		} else if (/^\t\S/.test(line)) {
			tests.push({ name: line.trim(), message: "" });
		} else {
			break;
		}
	}
	return tests;
}

/** The host's environment: what could reach outside the sandbox is removed. */
export function hostEnvironment(
	env: Readonly<Record<string, string | undefined>>,
	ceiling: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		// A git hook (husky's pre-commit) exports these, pointing at the real
		// repository; mutated code that runs git would act on it.
		if (
			/^GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|PREFIX)$/.test(
				key,
			)
		) {
			continue;
		}
		// Files outside the sandbox that a reporter in the user's config
		// would append to.
		if (/^GITHUB_(STEP_SUMMARY|OUTPUT|ENV|PATH)$/.test(key)) continue;
		if (key.startsWith("VITEST_")) continue;
		out[key] = value;
	}
	// The sandbox sits inside the repository; without this, git run there
	// finds the real `.git` above it.
	out["GIT_CEILING_DIRECTORIES"] = ceiling;
	// variant's own Vitest adapter, if the config has it, must not predict
	// inside a run of mutants.
	out["VARIANT_SHADOW"] = "0";
	return out;
}

// --------------------------------------------------------------- the files

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Removes a run's files. Refuses any path outside the check directory: the
 * sandboxes hold a link to the real `node_modules`, and a removal that
 * followed it would delete the user's dependencies.
 */
async function removeInside(root: string, target: string): Promise<void> {
	const resolved = path.resolve(target);
	if (!resolved.startsWith(path.resolve(root) + path.sep)) return;
	await rm(resolved, { recursive: true, force: true, maxRetries: 5 });
}

/** Removes what a run killed outright left behind. */
async function sweep(root: string): Promise<void> {
	const names = await readdir(root).catch(() => [] as string[]);
	await Promise.all(
		names
			.filter((name) => name.endsWith(".owner"))
			.map(async (name) => {
				const pid = Number(
					(
						await readFile(path.join(root, name), "utf8").catch(() => "")
					).trim(),
				);
				if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return;
				const runId = name.slice(0, -".owner".length);
				await Promise.all([
					removeInside(root, path.join(root, runId)),
					removeInside(root, path.join(root, `${runId}.json`)),
					removeInside(root, path.join(root, name)),
				]);
			}),
	);
}

// --------------------------------------------------------------- the run

/** Events in arrival order, consumed once. */
class Channel<T> implements AsyncIterable<T> {
	private readonly queue: T[] = [];
	private waiting: ((result: IteratorResult<T>) => void) | undefined;
	private closed = false;

	push(value: T): void {
		if (this.closed) return;
		const waiting = this.waiting;
		if (waiting !== undefined) {
			this.waiting = undefined;
			waiting({ value, done: false });
		} else {
			this.queue.push(value);
		}
	}

	close(): void {
		this.closed = true;
		const waiting = this.waiting;
		this.waiting = undefined;
		waiting?.({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const value = this.queue.shift();
				if (value !== undefined) return Promise.resolve({ value, done: false });
				if (this.closed)
					return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.waiting = resolve;
				});
			},
		};
	}
}

function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (
		pid === undefined ||
		child.exitCode !== null ||
		child.signalCode !== null
	) {
		return;
	}
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {});
		return;
	}
	try {
		// The host leads its own process group, so this reaches the workers
		// Stryker started too.
		process.kill(-pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, KILL_WAIT_MS);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function builtSibling(name: string): string {
	return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

export function createStrykerBackend(
	options: StrykerBackendOptions = {},
): MutationBackend {
	return {
		start: (request) => startRun(request, options),
	};
}

function startRun(
	request: BackendRequest,
	options: StrykerBackendOptions,
): BackendRun {
	const channel = new Channel<BackendEvent>();
	const output: string[] = [];
	const remember = (chunk: Uint8Array): void => {
		output.push(...new TextDecoder().decode(chunk).split(/\r?\n/));
		if (output.length > OUTPUT_LINES)
			output.splice(0, output.length - OUTPUT_LINES);
	};

	const root = path.join(request.cwd, CHECK_TMP);
	const roots = projectRoots(request.cwd);
	const variantDir = path.join(request.cwd, ".variant");
	const createdVariantDir = !existsSync(variantDir);
	const runId = `${Date.now().toString(36)}-${process.pid}`;
	let child: ChildProcess | undefined;
	let stopping = false;
	let stopped: Promise<void> | undefined;

	const cleanup = async (): Promise<void> => {
		await Promise.all([
			removeInside(root, path.join(root, runId)),
			removeInside(root, path.join(root, `${runId}.json`)),
			removeInside(root, path.join(root, `${runId}.owner`)),
		]);
		const left = await readdir(root).catch(() => [] as string[]);
		if (left.every((name) => name === ".gitignore")) {
			await rm(root, { recursive: true, force: true });
		}
		if (createdVariantDir) {
			const rest = await readdir(variantDir).catch(() => [] as string[]);
			if (rest.length === 0)
				await rm(variantDir, { recursive: true, force: true });
		}
	};

	const stop = (): Promise<void> => {
		stopped ??= (async () => {
			stopping = true;
			if (child !== undefined) {
				killTree(child);
				await exited(child);
			}
			await cleanup();
			channel.close();
		})();
		return stopped;
	};

	void (async () => {
		try {
			await mkdir(root, { recursive: true });
			// Ignores itself and everything beside it, so a run killed outright
			// never shows up in `git status`.
			await writeFile(path.join(root, ".gitignore"), "*\n");
			await sweep(root);
			await writeFile(path.join(root, `${runId}.owner`), String(process.pid));
			await writeFile(path.join(root, `${runId}.json`), "{}\n");
		} catch (error) {
			channel.push({
				kind: "error",
				message: `Could not prepare ${CHECK_TMP}: ${error instanceof Error ? error.message : String(error)}`,
				output: "",
			});
			channel.close();
			return;
		}
		if (stopping) return;

		const host: HostRequest = {
			mutate: request.mutate,
			...(request.vitestConfig !== undefined && {
				vitestConfig: request.vitestConfig,
			}),
			baselineTimeoutMinutes: request.baselineTimeoutMinutes,
			tempDirName: toPosix(path.join(CHECK_TMP, runId)),
			configFile: toPosix(path.join(CHECK_TMP, `${runId}.json`)),
			plugins: options.pluginsPath ?? builtSibling("stryker-plugins.js"),
		};
		const spawned = fork(
			options.hostPath ?? builtSibling("stryker-host.js"),
			[],
			{
				cwd: request.cwd,
				env: hostEnvironment(process.env, root),
				execArgv: options.execArgv ?? [],
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				// A process group of its own on POSIX, so one signal ends Stryker's
				// workers too. On Windows a detached process opens a console of its
				// own, and taskkill follows the process tree without one.
				detached: process.platform !== "win32",
			},
		);
		child = spawned;
		// Always drained: a full pipe would block Stryker.
		spawned.stdout?.on("data", remember);
		spawned.stderr?.on("data", remember);

		const dropped = new Set<string>();
		let terminal: HostMessage | undefined;
		spawned.on("message", (message: HostMessage) => {
			if (message.kind === "baseline") {
				channel.push({
					kind: "baseline",
					tests: message.tests.map((test) => toBaselineTest(roots, test)),
				});
			} else if (message.kind === "plan") {
				const kept = message.mutants.filter((mutant) => {
					if (!EXCLUDED.has(mutant.mutatorName)) return true;
					dropped.add(mutant.id);
					return false;
				});
				channel.push({
					kind: "plan",
					mutants: kept.map((mutant) => toPlannedMutant(roots, mutant)),
				});
			} else if (message.kind === "tested") {
				if (dropped.has(message.mutant.id)) return;
				channel.push({
					kind: "tested",
					mutant: toTestedMutant(message.mutant),
				});
			} else if (message.kind === "note") {
				channel.push({ kind: "note", text: message.text });
			} else {
				terminal = message;
				if (message.kind === "finished") channel.push({ kind: "finished" });
			}
		});
		spawned.on("error", (error) => {
			if (stopping) return;
			channel.push({
				kind: "error",
				message: error.message,
				output: output.join("\n"),
			});
			channel.close();
		});
		// A failure is reported once the output is complete: the failing
		// baseline tests are named only in the log.
		spawned.on("close", (code, signal) => {
			if (stopping) return;
			const text = output.join("\n").trim();
			if (terminal?.kind === "baseline-failed") {
				channel.push({
					kind: "baseline-failed",
					failingTests: parseFailingTests(text),
					output: text,
				});
			} else if (terminal?.kind === "error") {
				channel.push({
					kind: "error",
					message: terminal.message,
					output: text,
				});
			} else if (terminal === undefined) {
				channel.push({
					kind: "error",
					message: `The mutation-testing engine exited (${signal ?? `code ${code}`}) before it finished`,
					output: text,
				});
			}
			channel.close();
		});
		spawned.send(host);
	})();

	return { events: channel, stop };
}
