import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const adapter = pathToFileURL(path.join(repo, "dist/vitest.js")).href;
const vitestBin = path.join(repo, "node_modules/vitest/vitest.mjs");

const IDENTITY = ["-c", "user.email=t@t.com", "-c", "user.name=T"];

function write(cwd: string, files: Record<string, string>): void {
	for (const [relPath, contents] of Object.entries(files)) {
		const absolute = path.join(cwd, relPath);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, contents);
	}
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execa("git", [...IDENTITY, ...args], { cwd });
}

/** The user's own test command: Vitest, with nothing of variant's on it. */
function runTests(cwd: string, env: Record<string, string>) {
	return execa(
		"node",
		[
			vitestBin,
			"run",
			"--root",
			cwd,
			"--config",
			path.join(cwd, "vitest.config.mjs"),
		],
		{ cwd: repo, reject: false, env: { NO_COLOR: "1", ...env } },
	);
}

/**
 * A repository whose last commit breaks `add`, with one test that reaches it
 * (and now fails) and one that does not. The only trace of variant is one
 * line in the Vitest config.
 */
async function repoWithFailingChange(): Promise<string> {
	const cwd = mkdtempSync(path.join(tmpdir(), "variant-e2e-adapter-"));
	write(cwd, {
		".gitignore": ".variant/\n",
		"vitest.config.mjs": `import variant from ${JSON.stringify(adapter)};\nexport default { test: { globals: true, reporters: ["default", variant()] } };\n`,
		"src/math.ts":
			"export function add(a: number, b: number): number { return a + b; }\n",
		"src/math.test.ts":
			'import { add } from "./math";\ntest("adds", () => { expect(add(1, 2)).toBe(3); });\n',
		"src/other.test.ts": 'test("holds", () => { expect(1).toBe(1); });\n',
	});
	await git(cwd, "init", "-q", "-b", "main");
	await git(cwd, "add", "-A");
	await git(cwd, "commit", "-q", "-m", "initial");
	write(cwd, {
		"src/math.ts":
			"export function add(a: number, b: number): number { return a - b; }\n",
	});
	await git(cwd, "commit", "-q", "-am", "break add");
	return cwd;
}

function reconciliations(cwd: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(
			path.join(cwd, ".variant/history/reconciliation.jsonl"),
			"utf8",
		)
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

describe("E2E: the Vitest adapter", () => {
	let cwd: string;

	beforeAll(async () => {
		cwd = await repoWithFailingChange();
	});

	afterAll(() => {
		try {
			rmSync(cwd, { recursive: true, force: true });
		} catch {
			// Windows holds handles on a temp dir briefly after a child exits.
		}
	});

	it("says nothing and records nothing outside CI", async () => {
		const result = await runTests(cwd, { CI: "" });

		expect(result.stdout).not.toContain("variant:");
		expect(reconciliations(cwd)).toEqual([]);
	});

	it("predicts and reconciles a normal test run in CI, with no variant command", async () => {
		const result = await runTests(cwd, { CI: "true" });

		// The suite's own result is untouched: one test fails, so it exits 1.
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			"variant: predicted 1 of 2 test files (high). 1 failed, and it was predicted.",
		);
		expect(reconciliations(cwd)).toMatchObject([
			{
				ranTests: 2,
				predictedRan: 1,
				failedTests: 1,
				caught: 1,
				falseSkips: 0,
			},
		]);
	});
});

// The layout that makes the lock necessary: one Vitest process per package,
// all started at once, as `pnpm -r test` or a task runner does.
describe("E2E: the Vitest adapter with one test process per package", () => {
	let cwd: string;
	const packages = ["a", "b", "c"];

	beforeAll(async () => {
		cwd = mkdtempSync(path.join(tmpdir(), "variant-e2e-adapter-ws-"));
		const files: Record<string, string> = {
			".gitignore": ".variant/\n",
			"package.json": JSON.stringify({
				name: "root",
				workspaces: ["packages/*"],
			}),
		};
		for (const name of packages) {
			const dir = `packages/${name}`;
			files[`${dir}/package.json`] = JSON.stringify({ name: `@x/${name}` });
			files[`${dir}/vitest.config.mjs`] =
				`import variant from ${JSON.stringify(adapter)};\nexport default { test: { globals: true, reporters: ["default", variant()] } };\n`;
			files[`${dir}/src/${name}.ts`] =
				"export const value = (): number => 1;\n";
			files[`${dir}/src/${name}.test.ts`] =
				`import { value } from "./${name}";\ntest("${name}", () => { expect(value()).toBe(1); });\n`;
		}
		write(cwd, files);
		await git(cwd, "init", "-q", "-b", "main");
		await git(cwd, "add", "-A");
		await git(cwd, "commit", "-q", "-m", "initial");
		write(cwd, {
			"packages/b/src/b.ts": "export const value = (): number => 2;\n",
		});
		await git(cwd, "commit", "-q", "-am", "break b");
	});

	afterAll(() => {
		try {
			rmSync(cwd, { recursive: true, force: true });
		} catch {
			// Windows holds handles on a temp dir briefly after a child exits.
		}
	});

	it("predicts once for the repository and records each process's own files", async () => {
		const runs = await Promise.all(
			packages.map((name) => {
				const root = path.join(cwd, "packages", name);
				return execa(
					"node",
					[
						vitestBin,
						"run",
						"--root",
						root,
						"--config",
						path.join(root, "vitest.config.mjs"),
					],
					{ cwd: repo, reject: false, env: { NO_COLOR: "1", CI: "true" } },
				);
			}),
		);

		for (const run of runs) expect(run.stdout).toContain("variant: predicted");
		const predictions = readFileSync(
			path.join(cwd, ".variant/history/impact.jsonl"),
			"utf8",
		)
			.split("\n")
			.filter((line) => line.trim() !== "");
		expect(predictions).toHaveLength(1);

		const records = reconciliations(cwd);
		expect(records).toHaveLength(3);
		expect(
			records.filter((record) => record["failedTests"] === 1),
		).toMatchObject([
			{ ranTests: 1, predictedRan: 1, caught: 1, falseSkips: 0 },
		]);
	});
});
