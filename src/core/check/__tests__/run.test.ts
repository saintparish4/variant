import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BaselineFailedError,
	CheckBackendError,
	CheckRunnerError,
	CheckWorkspaceRootError,
	CliUsageError,
} from "../../errors.js";
import type {
	BackendEvent,
	BackendRequest,
	MutationBackend,
	PlannedMutant,
} from "../backend.js";
import type { CheckDeps } from "../run.js";
import { declaresWorkspaces, runCheck } from "../run.js";

const SOURCE =
	"export function q(total: number) {\n\treturn total >= 100;\n}\n";
const DIFF = "@@ -0,0 +1,3 @@\n+a\n+b\n+c";

function planned(id: string, covered = true): PlannedMutant {
	return {
		id,
		file: "src/q.ts",
		mutator: "EqualityOperator",
		replacement: "total > 100",
		start: { line: 2, column: 9 },
		end: { line: 2, column: 21 },
		covered,
		static: false,
	};
}

const baseline: BackendEvent = {
	kind: "baseline",
	tests: [{ id: "t", name: "t", file: "src/q.test.ts", skipped: false }],
};

/**
 * Plays `events` in order; an event of `"hang"` waits forever, as a slow
 * engine would. Records the request and whether it was stopped.
 */
function fakeBackend(events: (BackendEvent | "hang")[]) {
	const state = {
		request: undefined as BackendRequest | undefined,
		stopped: 0,
	};
	const backend: MutationBackend = {
		start: (request) => {
			state.request = request;
			return {
				events: (async function* () {
					for (const event of events) {
						if (event === "hang") await new Promise(() => {});
						else yield event;
					}
				})(),
				stop: async () => {
					state.stopped++;
				},
			};
		},
	};
	return { backend, state };
}

function deps(
	backend: MutationBackend,
	overrides: Partial<CheckDeps> = {},
): CheckDeps {
	let clock = 0;
	return {
		backend,
		now: () => clock++,
		resolveBase: async () => ({ ref: "HEAD", label: "HEAD" }),
		assertBase: async () => {},
		listChangedFiles: async () => ["src/q.ts", "src/q.test.ts"],
		listUntrackedFiles: async () => [],
		readDiff: async () => DIFF,
		readFile: async () => SOURCE,
		readFileAtBase: async () => SOURCE.replace("total", "sum"),
		isFormattingOnly: async () => false,
		isWorkspaceRoot: async () => false,
		detectRunner: async () => ({ kind: "vitest", nodeArgs: [] }),
		...overrides,
	};
}

const options = { maxMutants: 50, budgetMs: 60_000 };

describe("runCheck", () => {
	it("mutates only the changed source lines and reports the outcome", async () => {
		const { backend, state } = fakeBackend([
			baseline,
			{ kind: "plan", mutants: [planned("0")], coverageMeasured: true },
			{ kind: "tested", mutant: { id: "0", status: "Survived", killedBy: [] } },
			{ kind: "finished" },
		]);

		const result = await runCheck("/repo", options, deps(backend));

		expect(state.request?.mutate).toEqual(["src/q.ts:1-3"]);
		expect(result.status).toBe("complete");
		expect(result.counts.undetected).toBe(1);
		expect(result.excluded).toEqual([
			{ file: "src/q.test.ts", reason: "test" },
		]);
		expect(state.stopped).toBe(1);
	});

	it("mutates a new file git does not track yet, all of it", async () => {
		const { backend, state } = fakeBackend([
			baseline,
			{ kind: "plan", mutants: [], coverageMeasured: true },
			{ kind: "finished" },
		]);

		const result = await runCheck(
			"/repo",
			options,
			deps(backend, {
				listChangedFiles: async () => [],
				listUntrackedFiles: async () => ["src/new.ts", "notes.md"],
			}),
		);

		expect(state.request?.mutate).toEqual(["src/new.ts:1-3"]);
		expect(result.files[0]).toMatchObject({
			file: "src/new.ts",
			untracked: true,
		});
	});

	it("leaves out a file whose change the differ calls formatting only", async () => {
		const { backend, state } = fakeBackend([]);

		const result = await runCheck(
			"/repo",
			options,
			deps(backend, { isFormattingOnly: async () => true }),
		);

		expect(result.status).toBe("nothing-to-mutate");
		expect(result.excluded).toContainEqual({
			file: "src/q.ts",
			reason: "formatting-only",
		});
		expect(state.request).toBeUndefined();
	});

	it("names a failing baseline of files that did not load for what it is", () => {
		const error = new BaselineFailedError(
			[
				{
					name: "src/dictionary.test.ts (did not load)",
					message: "Cannot find module",
				},
			],
			"",
			"vitest",
		);
		expect(error.message).toBe(
			"1 test file did not load before any mutation, so no result could be trusted",
		);
		expect(
			new BaselineFailedError([{ name: "a", message: "x" }], "", "vitest")
				.message,
		).toBe("1 test fails before any mutation, so no result could be trusted");
	});

	it("starts no engine when no changed line can be mutated", async () => {
		const { backend, state } = fakeBackend([]);

		const result = await runCheck(
			"/repo",
			options,
			deps(backend, { listChangedFiles: async () => ["README.md"] }),
		);

		expect(result.status).toBe("nothing-to-mutate");
		expect(state.request).toBeUndefined();
	});

	it("stops once the first --max-mutants have reported, and says the rest were not run", async () => {
		const { backend, state } = fakeBackend([
			baseline,
			{
				kind: "plan",
				mutants: [planned("0"), planned("1"), planned("2")],
				coverageMeasured: true,
			},
			{
				kind: "tested",
				mutant: { id: "0", status: "Killed", killedBy: ["t"] },
			},
			"hang",
		]);

		const result = await runCheck(
			"/repo",
			{ ...options, maxMutants: 1 },
			deps(backend),
		);

		expect(result.status).toBe("incomplete");
		expect(result.stopReason).toBe("limit");
		expect(result.counts["not-run"]).toBe(2);
		expect(state.stopped).toBe(1);
	});

	it("stops at the budget and reports what finished as incomplete", async () => {
		const { backend } = fakeBackend([
			baseline,
			{
				kind: "plan",
				mutants: [planned("0"), planned("1")],
				coverageMeasured: true,
			},
			{
				kind: "tested",
				mutant: { id: "0", status: "Killed", killedBy: ["t"] },
			},
			"hang",
		]);
		let clock = 0;

		const result = await runCheck(
			"/repo",
			{ ...options, budgetMs: 50 },
			deps(backend, { now: () => (clock += 10) }),
		);

		expect(result.status).toBe("incomplete");
		expect(result.stopReason).toBe("budget");
		expect(result.counts.detected).toBe(1);
	});

	it("stops when interrupted and keeps what finished", async () => {
		const { backend } = fakeBackend([
			baseline,
			{
				kind: "plan",
				mutants: [planned("0"), planned("1")],
				coverageMeasured: true,
			},
			{
				kind: "tested",
				mutant: { id: "0", status: "Killed", killedBy: ["t"] },
			},
			"hang",
		]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		const result = await runCheck(
			"/repo",
			{ ...options, signal: controller.signal },
			deps(backend),
		);

		expect(result.stopReason).toBe("interrupted");
		expect(result.status).toBe("incomplete");
		expect(result.counts.detected).toBe(1);
	});

	it("interprets nothing when the tests fail before any mutation", async () => {
		const { backend } = fakeBackend([
			{
				kind: "baseline-failed",
				failingTests: [{ name: "q rejects 50", message: "expected true" }],
				output: "",
			},
		]);

		await expect(
			runCheck("/repo", options, deps(backend)),
		).rejects.toBeInstanceOf(BaselineFailedError);
	});

	it("reports an engine failure as one, with its output", async () => {
		const { backend } = fakeBackend([
			{ kind: "error", message: "Cannot find vitest", output: "trace" },
		]);

		await expect(
			runCheck("/repo", options, deps(backend)),
		).rejects.toMatchObject({
			code: "CHECK_BACKEND",
			output: "trace",
		});
	});

	it("never reads an engine that went quiet as a result", async () => {
		const { backend } = fakeBackend([baseline]);

		await expect(
			runCheck("/repo", options, deps(backend)),
		).rejects.toBeInstanceOf(CheckBackendError);
	});

	it("refuses a workspace root, where mutants of a package would read as unreached", async () => {
		const { backend } = fakeBackend([]);

		await expect(
			runCheck(
				"/repo",
				options,
				deps(backend, { isWorkspaceRoot: async () => true }),
			),
		).rejects.toBeInstanceOf(CheckWorkspaceRootError);
	});

	// Stryker took 13 to 17 seconds on a package with no runner before
	// saying only that no tests ran.
	it("says there is no runner here before starting the engine", async () => {
		const { backend, state } = fakeBackend([]);

		const error = await runCheck(
			"/repo",
			options,
			deps(backend, {
				detectRunner: async () => ({ kind: "none", nodeArgs: [] }),
			}),
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(CheckRunnerError);
		expect(state.request).toBeUndefined();
	});

	it("runs a Jest package's tests with Jest, with the flags its test script uses", async () => {
		const { backend, state } = fakeBackend([
			baseline,
			{ kind: "plan", mutants: [], coverageMeasured: true },
			{ kind: "finished" },
		]);

		const result = await runCheck(
			"/repo",
			options,
			deps(backend, {
				detectRunner: async () => ({
					kind: "jest",
					nodeArgs: ["--experimental-vm-modules"],
				}),
			}),
		);

		expect(state.request?.runner).toEqual({
			kind: "jest",
			nodeArgs: ["--experimental-vm-modules"],
		});
		expect(result.runner.kind).toBe("jest");
	});

	it("runs the runner it was given over the one it finds", async () => {
		const { backend, state } = fakeBackend([
			baseline,
			{ kind: "plan", mutants: [], coverageMeasured: true },
			{ kind: "finished" },
		]);

		await runCheck(
			"/repo",
			{
				...options,
				runner: { kind: "vitest", configFile: "vitest.unit.config.ts" },
			},
			deps(backend, {
				detectRunner: async () => ({ kind: "none", nodeArgs: [] }),
			}),
		);

		expect(state.request?.runner).toEqual({
			kind: "vitest",
			configFile: "vitest.unit.config.ts",
		});
	});

	// The tests run in a copy of the package. A config named outside it, or
	// by an absolute path, would run them against the real files instead:
	// for Jest, whose root follows its config, snapshots included.
	it.each([
		["outside the package", "../vitest.config.ts"],
		[
			"by an absolute path elsewhere",
			path.join(path.sep, "elsewhere", "vitest.config.ts"),
		],
	])("refuses a config %s", async (_, configFile) => {
		const { backend, state } = fakeBackend([]);

		const error = await runCheck(
			"/repo",
			{ ...options, runner: { kind: "vitest", configFile } },
			deps(backend),
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(CliUsageError);
		expect((error as CliUsageError).message).toMatch(/--vitest-config/);
		expect(state.request).toBeUndefined();
	});

	it("names a config inside the package relative to it", async () => {
		const { backend, state } = fakeBackend([
			baseline,
			{ kind: "plan", mutants: [], coverageMeasured: true },
			{ kind: "finished" },
		]);

		await runCheck(
			"/repo",
			{
				...options,
				runner: {
					kind: "vitest",
					configFile: path.join(path.resolve("/repo"), "config", "vitest.ts"),
				},
			},
			deps(backend),
		);

		expect(state.request?.runner.configFile).toBe("config/vitest.ts");
	});

	it("passes on what the engine noted about the run", async () => {
		const { backend } = fakeBackend([
			{ kind: "note", text: "tsconfig paths were not rewritten" },
			baseline,
			{ kind: "plan", mutants: [], coverageMeasured: true },
			{ kind: "finished" },
		]);

		const result = await runCheck("/repo", options, deps(backend));

		expect(result.notes).toContain("tsconfig paths were not rewritten");
	});

	it("notes a file edited during the run, whose report quotes it as it was", async () => {
		const { backend } = fakeBackend([
			baseline,
			{ kind: "plan", mutants: [planned("0")], coverageMeasured: true },
			{
				kind: "tested",
				mutant: { id: "0", status: "Killed", killedBy: ["t"] },
			},
			{ kind: "finished" },
		]);
		let reads = 0;

		const result = await runCheck(
			"/repo",
			options,
			deps(backend, {
				readFile: async () => (reads++ === 0 ? SOURCE : `${SOURCE}// edited\n`),
			}),
		);

		expect(result.notes).toEqual([
			"src/q.ts changed while variant check ran; the report quotes it as it was when the run started.",
		]);
		expect(result.mutants[0]?.original).toBe("total >= 100");
	});
});

describe("declaresWorkspaces", () => {
	it("reads a pnpm-workspace.yaml that lists packages as a workspace root", () => {
		expect(declaresWorkspaces("packages:\n  - packages/*\n", null)).toBe(true);
	});

	// pnpm 10 keeps its settings in that file, so one with no `packages:` is
	// an ordinary single package.
	it("does not read a pnpm-workspace.yaml holding only settings as a workspace", () => {
		expect(
			declaresWorkspaces('overrides:\n  "vitest>picomatch": "^4.0.4"\n', null),
		).toBe(false);
	});

	it("reads package.json workspaces as a workspace root", () => {
		expect(declaresWorkspaces(null, '{"workspaces":["web"]}')).toBe(true);
	});

	it("reads a plain package as no workspace", () => {
		expect(declaresWorkspaces(null, '{"name":"app"}')).toBe(false);
		expect(declaresWorkspaces(null, "not json")).toBe(false);
	});
});
