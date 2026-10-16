import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
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
const cli = path.join(repo, "dist", "cli.js");

const IDENTITY = ["-c", "user.email=t@t.com", "-c", "user.name=T"];

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execa("git", [...IDENTITY, ...args], { cwd });
}

function variant(cwd: string, ...args: string[]) {
	return execa("node", [cli, ...args], {
		cwd,
		reject: false,
		// pnpm's command shims point NODE_PATH at every package in its store,
		// which hides a package the project itself does not have.
		env: { NO_COLOR: "1", NODE_PATH: "" },
	});
}

interface Demo {
	example: string;
	/**
	 * Linked into the copy's `node_modules`, as pnpm would install them: the
	 * runner and the transform, and none of the runner's own dependencies.
	 */
	packages: string[];
	/** Committed before the change. */
	setup: string[];
}

const VITEST: Demo = {
	example: "check-demo",
	packages: ["vitest"],
	setup: ["package.json", "vitest.config.ts", ".gitignore"],
};

const JEST: Demo = {
	example: "check-demo-jest",
	packages: [
		"jest",
		"@babel/core",
		"@babel/preset-typescript",
		"@babel/plugin-transform-modules-commonjs",
	],
	setup: ["package.json", "babel.config.js", ".gitignore"],
};

/** Process ids of this build's Stryker host still running. */
async function hostsStillRunning(): Promise<string[]> {
	const host = path.join(repo, "dist", "stryker-host.js");
	if (process.platform === "win32") {
		const { stdout } = await execa(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json",
			],
			{ reject: false },
		);
		const rows = JSON.parse(stdout || "[]") as
			| { ProcessId: number; CommandLine: string | null }[]
			| { ProcessId: number; CommandLine: string | null };
		return (Array.isArray(rows) ? rows : [rows])
			.filter((row) => row.CommandLine?.includes(host) === true)
			.map((row) => String(row.ProcessId));
	}
	const { stdout } = await execa("ps", ["-eo", "pid=,args="], {
		reject: false,
	});
	return stdout
		.split("\n")
		.filter((line) => line.includes(host))
		.map((line) => line.trim().split(/\s+/)[0] ?? "");
}

describe.each([
	["Vitest", VITEST],
	["Jest", JEST],
])("E2E: would the %s tests notice?", (_, demo) => {
	let cwd: string;

	beforeAll(async () => {
		cwd = mkdtempSync(path.join(tmpdir(), "variant-check-e2e-"));
		cpSync(path.join(repo, "examples", demo.example), cwd, {
			recursive: true,
		});
		for (const name of demo.packages) {
			const link = path.join(cwd, "node_modules", name);
			mkdirSync(path.dirname(link), { recursive: true });
			symlinkSync(
				realpathSync(path.join(repo, "node_modules", name)),
				link,
				process.platform === "win32" ? "junction" : "dir",
			);
		}
		writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
		await git(cwd, "init", "-q", "-b", "main");
		await git(cwd, "add", ...demo.setup);
		await git(cwd, "commit", "-qm", "setup");
		// The discount rule, staged: the change about to be committed.
		await git(cwd, "add", "src");
	});

	afterAll(() => {
		// Windows holds directory handles for a while after the processes using
		// them exit; the shared test helper tolerates the same. That a process
		// of ours is still running is asserted in the test itself.
		try {
			rmSync(cwd, {
				recursive: true,
				force: true,
				maxRetries: 20,
				retryDelay: 500,
			});
		} catch (error) {
			if (process.platform !== "win32") throw error;
		}
	});

	it("names the boundary the tests miss, then sees it caught once a test checks it", async () => {
		const missed = await variant(cwd, "check");

		expect(missed.exitCode).toBe(0);
		expect(missed.stdout).toContain(
			"Changing >= to > went undetected. Review the behavior at total = 100.",
		);
		expect(missed.stdout).toContain("    - total >= 100");
		expect(missed.stdout).toContain("    + total > 100");

		const gated = await variant(cwd, "check", "--fail-on-survivors");
		expect(gated.exitCode).toBe(1);

		const test = path.join(cwd, "src", "discount.test.ts");
		writeFileSync(
			test,
			readFileSync(test, "utf8").replace(
				`	it("accepts a large order", () => {`,
				`	it("accepts an order of exactly 100", () => {
		expect(qualifiesForDiscount(100)).toBe(true);
	});

	it("accepts a large order", () => {`,
			),
		);

		const caught = await variant(cwd, "check", "--fail-on-survivors");
		expect(caught.exitCode).toBe(0);
		expect(caught.stdout).toContain("were detected by the tests that ran.");
		expect(caught.stdout).not.toContain("Undetected");

		// The working tree is as the developer left it: the staged change, the
		// unstaged test and the example's README, never added. Nothing the
		// runner wrote (snapshots, coverage, a cache) is there.
		const { stdout: status } = await execa(
			"git",
			["status", "--porcelain", "--untracked-files=all"],
			{ cwd },
		);
		expect(status.split("\n").sort()).toEqual(
			["?? README.md", "AM src/discount.test.ts", "A  src/discount.ts"].sort(),
		);

		// The engine runs in a host process with workers under it; none may
		// outlive the command. Matched by this build's host, so the
		// integration tests' hosts running beside this one do not count.
		expect(await hostsStillRunning()).toEqual([]);
	}, 120_000);
});
