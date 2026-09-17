import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "../fixtures/basic-monorepo");
const cli = path.resolve(here, "../../../dist/cli.js");

const ESC = "";
const FIRST_RUN_REASON =
	"ran because: cache miss — nothing cached for this task yet";

function copyFixture(prefix: string): string {
	const cwd = mkdtempSync(path.join(tmpdir(), prefix));
	cpSync(fixture, cwd, { recursive: true });
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

describe("E2E: why did this task run?", () => {
	let cwd: string;

	beforeAll(async () => {
		cwd = copyFixture("variant-prov-");

		// Break exactly one package's build. The fixture is shared across tiers,
		// so the failure is introduced in the temp copy, never committed.
		const manifest = path.join(cwd, "packages/web/package.json");
		const web = JSON.parse(await readFile(manifest, "utf8"));
		web.scripts.build = 'node -e "process.exit(1)"';
		await writeFile(manifest, JSON.stringify(web, null, 2));
	});

	afterAll(() => remove(cwd));

	// Each run starts uncached, so the reason tells the same story every time.
	beforeEach(() => remove(path.join(cwd, ".variant")));

	function build(env: Record<string, string>) {
		return execa("node", [cli, "build"], { cwd, reject: false, env });
	}

	it("a failing task explains why it was running", async () => {
		const result = await build({ NO_COLOR: "1" });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Task "web:build" failed');
		expect(result.stderr).toContain(FIRST_RUN_REASON);
	});

	it("carries the same reason when color is suppressed", async () => {
		const styled = await build({ FORCE_COLOR: "1" });
		remove(path.join(cwd, ".variant"));
		const plain = await build({ NO_COLOR: "1" });

		expect(styled.stderr).toContain(FIRST_RUN_REASON);
		expect(plain.stderr).toContain(FIRST_RUN_REASON);
		// Dropping color drops the escapes, never the content.
		expect(styled.stderr).toContain(ESC);
		expect(plain.stderr).not.toContain(ESC);
	});
});

describe("E2E: provenance stays invisible on success", () => {
	let cwd: string;

	beforeAll(() => {
		cwd = copyFixture("variant-prov-ok-");
	});
	afterAll(() => remove(cwd));

	it("says nothing about why tasks ran when they all pass", async () => {
		const result = await execa("node", [cli, "build"], {
			cwd,
			reject: false,
			env: { NO_COLOR: "1" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("ran because:");
		expect(result.stderr).not.toContain("ran because:");
	});
});
