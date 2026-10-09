import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const vitestBin = path.join(repo, "node_modules/vitest/vitest.mjs");

const IDENTITY = ["-c", "user.email=t@t.com", "-c", "user.name=T"];

function write(cwd: string, files: Record<string, string>): void {
	for (const [relPath, contents] of Object.entries(files)) {
		const absolute = path.join(cwd, relPath);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, contents);
	}
}

/**
 * The one line `variant init` adds, importing the adapter by its package name
 * as a user's config does. How the runner loads that import depends on the
 * package the config is in, so the fixtures say which kind they are.
 */
const CONFIG =
	'import variant from "@blzsky/variant/vitest";\nexport default { test: { globals: true, reporters: ["default", variant()] } };\n';

/**
 * The whole config `variant init` writes for a package that runs Vitest
 * without one. Kept as text here on purpose: this is the file a user ends up
 * with, and the test is that a real run accepts it.
 */
const CREATED_FILE = "vitest.config.mts";
const CREATED_CONFIG =
	'import { variantReporters } from "@blzsky/variant/vitest";\n\nexport default {\n\ttest: {\n\t\treporters: variantReporters(),\n\t},\n};\n';

/** Makes `@blzsky/variant` resolve to this checkout, as an install would. */
function linkVariant(cwd: string): void {
	const scope = path.join(cwd, "node_modules/@blzsky");
	mkdirSync(scope, { recursive: true });
	symlinkSync(repo, path.join(scope, "variant"), "junction");
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execa("git", [...IDENTITY, ...args], { cwd });
}

/** The user's own test command: Vitest, with nothing of variant's on it. */
function runTests(
	cwd: string,
	env: Record<string, string>,
	configFile = "vitest.config.ts",
) {
	return execa(
		"node",
		[vitestBin, "run", "--root", cwd, "--config", path.join(cwd, configFile)],
		{ cwd: repo, reject: false, env: { NO_COLOR: "1", ...env } },
	);
}

/**
 * A repository whose last commit breaks `add`, with one test that reaches it
 * (and now fails) and one that does not. The only trace of variant is one
 * line in the Vitest config.
 */
async function repoWithFailingChange(
	manifest: Record<string, unknown>,
	config: string = CONFIG,
	configFile = "vitest.config.ts",
): Promise<string> {
	const cwd = mkdtempSync(path.join(tmpdir(), "variant-e2e-adapter-"));
	write(cwd, {
		".gitignore": ".variant/\nnode_modules\n",
		"package.json": JSON.stringify(manifest),
		[configFile]: config,
		"src/math.ts":
			"export function add(a: number, b: number): number { return a + b; }\n",
		"src/math.test.ts":
			'import { expect, test } from "vitest";\nimport { add } from "./math";\ntest("adds", () => { expect(add(1, 2)).toBe(3); });\n',
		"src/other.test.ts":
			'import { expect, test } from "vitest";\ntest("holds", () => { expect(1).toBe(1); });\n',
	});
	await git(cwd, "init", "-q", "-b", "main");
	await git(cwd, "add", "-A");
	await git(cwd, "commit", "-q", "-m", "initial");
	write(cwd, {
		"src/math.ts":
			"export function add(a: number, b: number): number { return a - b; }\n",
	});
	await git(cwd, "commit", "-q", "-am", "break add");
	linkVariant(cwd);
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

	// No `"type": "module"`: the usual case, and the one where the runner
	// loads what its config imports with `require`.
	beforeAll(async () => {
		cwd = await repoWithFailingChange({ name: "app" });
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

describe("E2E: the Vitest adapter in an ES-module package", () => {
	let cwd: string;

	beforeAll(async () => {
		cwd = await repoWithFailingChange({ name: "app", type: "module" });
	});

	afterAll(() => {
		try {
			rmSync(cwd, { recursive: true, force: true });
		} catch {
			// Windows holds handles on a temp dir briefly after a child exits.
		}
	});

	it("loads and reports the same way", async () => {
		const result = await runTests(cwd, { CI: "true" });

		expect(result.stdout).toContain(
			"variant: predicted 1 of 2 test files (high). 1 failed, and it was predicted.",
		);
	});
});

describe("E2E: the Vitest adapter in the config `init` creates", () => {
	let cwd: string;

	beforeAll(async () => {
		cwd = await repoWithFailingChange(
			{ name: "app" },
			CREATED_CONFIG,
			CREATED_FILE,
		);
	});

	afterAll(() => {
		try {
			rmSync(cwd, { recursive: true, force: true });
		} catch {
			// Windows holds handles on a temp dir briefly after a child exits.
		}
	});

	it("runs the suite as before and adds the variant line", async () => {
		const result = await runTests(cwd, { CI: "true" }, CREATED_FILE);

		// As `.ts` in a package without `"type": "module"`, Vite warned on
		// every run that the file was ESM loaded as CommonJS.
		expect(`${result.stdout}${result.stderr}`).not.toContain(
			"loaded as CommonJS",
		);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("1 failed | 1 passed");
		expect(result.stdout).toContain(
			"variant: predicted 1 of 2 test files (high). 1 failed, and it was predicted.",
		);
	});

	it("keeps Vitest's GitHub Actions annotations", async () => {
		const result = await runTests(
			cwd,
			{ CI: "true", GITHUB_ACTIONS: "true", VARIANT_SHADOW: "0" },
			CREATED_FILE,
		);

		expect(result.stdout).toContain("::error");
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
			".gitignore": ".variant/\nnode_modules\n",
			"package.json": JSON.stringify({
				name: "root",
				workspaces: ["packages/*"],
			}),
		};
		for (const name of packages) {
			const dir = `packages/${name}`;
			files[`${dir}/package.json`] = JSON.stringify({ name: `@x/${name}` });
			files[`${dir}/vitest.config.ts`] = CONFIG;
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
		linkVariant(cwd);
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
						path.join(root, "vitest.config.ts"),
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
