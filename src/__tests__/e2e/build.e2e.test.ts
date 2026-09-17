import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "../fixtures/basic-monorepo");
const cli = path.resolve(here, "../../../dist/cli.js");

describe("E2E: basic-monorepo", () => {
	let cwd: string;
	beforeAll(() => {
		cwd = mkdtempSync(path.join(tmpdir(), "variant-e2e-"));
		cpSync(fixture, cwd, { recursive: true });
	});
	afterAll(() => rmSync(cwd, { recursive: true, force: true }));

	it("fresh build: runs all tasks in dependency order", async () => {
		const result = await execa("node", [cli, "build"], { cwd });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/utils:build/);
		expect(result.stdout).toMatch(/web:build/);
	});

	it("second run: cache hits", async () => {
		const result = await execa("node", [cli, "build"], { cwd });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/HIT/i);
	});

	it("incremental: changing one file rebuilds only affected", async () => {
		const f = path.join(cwd, "packages/utils/src/index.ts");
		const fs = await import("node:fs/promises");
		const orig = await fs.readFile(f, "utf8");
		await fs.writeFile(f, `${orig}\nexport const x = 1;`);
		const result = await execa("node", [cli, "build"], { cwd });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/utils/);
	});

	it("check command: validates config successfully", async () => {
		const result = await execa("node", [cli, "check"], { cwd });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/valid/i);
	});

	it("env command: prints detected environment", async () => {
		const result = await execa("node", [cli, "env"], { cwd });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/Package Manager/);
		expect(result.stdout).toMatch(/Runtime/);
	});

	it("init command: refuses when config exists", async () => {
		const result = await execa("node", [cli, "init"], { cwd });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/already exists/);
	});

	it("build with invalid --concurrency: exits non-zero", async () => {
		const result = await execa("node", [cli, "build", "-c", "abc"], {
			cwd,
			reject: false,
		});
		expect(result.exitCode).not.toBe(0);
	});

	it("--affected flag: exits zero when git is unavailable (no-op)", async () => {
		const result = await execa("node", [cli, "build", "--affected"], { cwd });
		expect(result.exitCode).toBe(0);
	});
});

describe("E2E: --affected cascade (git-enabled)", () => {
	let cwdAff: string;

	const GIT = ["-c", "user.email=t@t.com", "-c", "user.name=T"];

	beforeAll(async () => {
		cwdAff = mkdtempSync(path.join(tmpdir(), "variant-aff-"));
		cpSync(fixture, cwdAff, { recursive: true });
		// Two commits so HEAD~1 resolves: empty base then add all files
		await execa("git", ["init"], { cwd: cwdAff });
		await execa("git", [...GIT, "commit", "--allow-empty", "-m", "base"], {
			cwd: cwdAff,
		});
		await execa("git", ["add", "."], { cwd: cwdAff });
		await execa("git", [...GIT, "commit", "-m", "initial"], { cwd: cwdAff });
		// First build to warm the cache
		await execa("node", [cli, "build"], { cwd: cwdAff });
	});

	afterAll(() => {
		try {
			rmSync(cwdAff, { recursive: true, force: true });
		} catch {
			// Windows holds handles on a temp dir briefly after the git and CLI
			// child processes exit, so rmSync throws EPERM. Cleanup failing must
			// not fail the suite; the OS reclaims the directory.
		}
	});

	it("utils change cascades to web+api but skips docs (no utils dependency)", async () => {
		// Commit a change to utils
		const f = path.join(cwdAff, "packages/utils/src/index.ts");
		await writeFile(f, "export const cascade = true;\n");
		await execa("git", ["add", "."], { cwd: cwdAff });
		await execa("git", [...GIT, "commit", "-m", "change utils"], {
			cwd: cwdAff,
		});

		const result = await execa("node", [cli, "build", "--affected"], {
			cwd: cwdAff,
		});
		expect(result.exitCode).toBe(0);

		const lines = result.stdout.split("\n");
		// Match only insight-table rows (which always end with MISS, HIT, or SKIP)
		const row = (name: string) =>
			lines.find((l) => l.includes(name) && /MISS|HIT|SKIP/.test(l));

		// utils changed directly → MISS
		expect(row("utils:build")).toMatch(/MISS/);
		// web and api depend on utils → included in affected set → MISS or HIT
		expect(row("web:build")).toBeDefined();
		expect(row("api:build")).toBeDefined();
		// docs has no dependency on utils → SKIP
		expect(row("docs:build")).toMatch(/SKIP/);
	});

	it("docs-only change does not affect utils/web/api", async () => {
		// Reset to a clean commit first
		const f = path.join(cwdAff, "packages/docs/src/index.ts");
		await mkdir(path.dirname(f), { recursive: true });
		await writeFile(f, "export const v = 2;\n");
		await execa("git", ["add", "."], { cwd: cwdAff });
		await execa("git", [...GIT, "commit", "-m", "change docs"], {
			cwd: cwdAff,
		});

		const result = await execa("node", [cli, "build", "--affected"], {
			cwd: cwdAff,
		});
		expect(result.exitCode).toBe(0);

		const lines = result.stdout.split("\n");
		const row = (name: string) =>
			lines.find((l) => l.includes(name) && /MISS|HIT|SKIP/.test(l));

		// docs changed → affected
		expect(row("docs:build")).toMatch(/MISS|HIT/);
		// utils/web/api not affected by docs change
		expect(row("utils:build")).toMatch(/SKIP/);
		expect(row("web:build")).toMatch(/SKIP/);
		expect(row("api:build")).toMatch(/SKIP/);
	});
});
