import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../../dist/cli.js");

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

function variant(cwd: string, ...args: string[]) {
	return execa("node", [cli, ...args], {
		cwd,
		reject: false,
		env: { NO_COLOR: "1" },
	});
}

/**
 * A repository whose last commit changes the signature of `add`, with one
 * test that reaches it and one that does not, a logged prediction for that
 * commit, and a Vitest-shaped report in which the reaching test failed.
 */
async function repoWithPrediction(): Promise<string> {
	const cwd = mkdtempSync(path.join(tmpdir(), "variant-e2e-impact-"));
	write(cwd, {
		"src/math.ts":
			"export function add(a: number, b: number): number { return a + b; }\n",
		"src/math.test.ts": 'import { add } from "./math.js";\nadd(1, 2);\n',
		"src/other.test.ts": "export const other = 1;\n",
	});
	await git(cwd, "init", "-q", "-b", "main");
	await git(cwd, "add", "-A");
	await git(cwd, "commit", "-q", "-m", "initial");
	write(cwd, {
		"src/math.ts":
			"export function add(a: number, b: number, c = 0): number { return a + b + c; }\n",
	});
	await git(cwd, "commit", "-q", "-am", "widen add");

	const predicted = await variant(cwd, "impact");
	expect(predicted.exitCode).toBe(0);

	write(cwd, {
		"report.json": JSON.stringify({
			testResults: [
				{ name: path.join(cwd, "src/math.test.ts"), status: "failed" },
				{ name: path.join(cwd, "src/other.test.ts"), status: "passed" },
			],
		}),
	});
	return cwd;
}

function remove(target: string): void {
	try {
		rmSync(target, { recursive: true, force: true });
	} catch {
		// Windows holds handles on a temp dir briefly after the CLI child process
		// exits, so rmSync throws EPERM. Cleanup failing must not fail the suite.
	}
}

describe("E2E: reconciling a prediction for CI", () => {
	let cwd: string;

	beforeAll(async () => {
		cwd = await repoWithPrediction();
	});

	afterAll(() => remove(cwd));

	// `impact` and `impact verify` both define --json; Commander hands the flag
	// to the parent, so the subcommand once never saw it.
	it.each([
		["after the report", ["impact", "verify", "report.json", "--json"]],
		["before the report", ["impact", "verify", "--json", "report.json"]],
	])("impact verify --json prints JSON when the flag comes %s", async (_, args) => {
		const result = await variant(cwd, ...args);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout) as {
			matchedBy: string;
			failedTests: string[];
			caught: string[];
			falseSkips: string[];
		};
		expect(parsed.matchedBy).toBe("most-recent");
		expect(parsed.failedTests).toEqual(["src/math.test.ts"]);
		expect(parsed.caught).toEqual(["src/math.test.ts"]);
		expect(parsed.falseSkips).toEqual([]);
	});

	it("-q keeps the JSON a script asked for", async () => {
		const result = await variant(
			cwd,
			"-q",
			"impact",
			"verify",
			"report.json",
			"--json",
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			matchedBy: "most-recent",
		});
	});

	it("-qq prints nothing but still reports errors", async () => {
		const quiet = await variant(cwd, "-qq", "impact", "verify", "report.json");
		expect(quiet.exitCode).toBe(0);
		expect(quiet.stdout).toBe("");

		const failed = await variant(
			cwd,
			"-qq",
			"impact",
			"verify",
			"missing.json",
		);
		expect(failed.exitCode).toBe(1);
		expect(failed.stderr).toContain("IMPACT_REPORT_ERROR");
	});
});
