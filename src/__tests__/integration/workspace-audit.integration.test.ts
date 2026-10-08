/**
 * Boundary: the workspace audit reading real manifests and building a real
 * symbol graph, plus the CI gate the command puts on top of it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { registerWorkspaceCheckAction } from "../../cli/commands/workspace.js";
import { auditWorkspace } from "../../core/graph/workspace-audit.js";
import {
	captureGlobalOutput,
	cleanupTempWorkspaces,
	createTempWorkspace,
	restoreGlobalPrinter,
	withCwd,
	writeFiles,
} from "../helpers/cli-harness.js";

/** A monorepo where @org/web imports @org/auth; `webDeps` decides legality. */
function workspaceImporting(
	dir: string,
	webDeps: Record<string, string>,
): void {
	writeFiles(dir, {
		"package.json": JSON.stringify({
			name: "root",
			workspaces: ["packages/*", "apps/*"],
		}),
		"packages/auth/package.json": JSON.stringify({ name: "@org/auth" }),
		"packages/auth/src/index.ts": "export const login = (): number => 1;",
		"apps/web/package.json": JSON.stringify({
			name: "@org/web",
			dependencies: webDeps,
		}),
		"apps/web/src/page.ts":
			'import { login } from "@org/auth";\nexport const page = login();',
	});
}

afterEach(() => {
	cleanupTempWorkspaces();
	restoreGlobalPrinter();
	process.exitCode = 0;
});

describe("auditWorkspace", () => {
	it("finds an undeclared workspace dependency", async () => {
		const dir = createTempWorkspace("wscheck");
		workspaceImporting(dir, {});

		const result = await auditWorkspace(dir);

		expect(result?.packagesChecked).toBe(2);
		expect(result?.violations).toEqual([
			{
				kind: "undeclared-workspace-dep",
				package: "@org/web",
				target: "@org/auth",
				files: ["apps/web/src/page.ts"],
			},
		]);
	});

	it("passes once the dependency is declared", async () => {
		const dir = createTempWorkspace("wscheck");
		workspaceImporting(dir, { "@org/auth": "workspace:*" });

		expect((await auditWorkspace(dir))?.violations).toEqual([]);
	});

	it("does not report an import through a package's own tsconfig alias", async () => {
		const dir = createTempWorkspace("wscheck");
		workspaceImporting(dir, { "@org/auth": "workspace:*" });
		writeFiles(dir, {
			"apps/web/tsconfig.json": JSON.stringify({
				compilerOptions: { paths: { "@/*": ["./src/*"] } },
			}),
			"apps/web/src/lib/price.ts": "export const price = 1;",
			"apps/web/src/cart.ts":
				'import { price } from "@/lib/price";\nexport const cart = price;',
		});

		expect((await auditWorkspace(dir))?.violations).toEqual([]);
	});

	it("judges a package nested inside a workspace package by its own manifest", async () => {
		const dir = createTempWorkspace("wscheck");
		workspaceImporting(dir, { "@org/auth": "workspace:*" });
		writeFiles(dir, {
			"apps/web/samples/basic/package.json": JSON.stringify({
				name: "basic",
				dependencies: { react: "19" },
			}),
			"apps/web/samples/basic/src/app.ts":
				'import { use } from "react";\nexport const app = use;',
		});

		expect((await auditWorkspace(dir))?.violations).toEqual([]);
	});

	it("returns null outside a workspace", async () => {
		const dir = createTempWorkspace("wscheck");
		writeFiles(dir, {
			"package.json": JSON.stringify({ name: "solo" }),
			"src/a.ts": "export const a = 1;",
		});

		expect(await auditWorkspace(dir)).toBeNull();
	});
});

describe("workspace check command", () => {
	it("prints violations and fails the pipeline", async () => {
		const dir = createTempWorkspace("wscheck");
		workspaceImporting(dir, {});
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerWorkspaceCheckAction());

		expect(output.stdout()).toContain("Checked 2 packages.");
		expect(output.stdout()).toContain(
			"@org/web imports @org/auth but does not declare it",
		);
		expect(output.stdout()).toContain("apps/web/src/page.ts");
		expect(output.stdout()).toContain("1 violation found.");
		expect(process.exitCode).toBe(1);
	});

	it("reports a clean workspace without failing", async () => {
		const dir = createTempWorkspace("wscheck");
		workspaceImporting(dir, { "@org/auth": "workspace:*" });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerWorkspaceCheckAction());

		expect(output.stdout()).toContain("No dependency violations found.");
		expect(process.exitCode).toBe(0);
	});

	it("emits parseable JSON with --json and still gates CI", async () => {
		const dir = createTempWorkspace("wscheck");
		workspaceImporting(dir, {});
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerWorkspaceCheckAction({ json: true }));

		const parsed = JSON.parse(output.stdout()) as {
			violations: Array<{ kind: string }>;
		};
		expect(parsed.violations[0]?.kind).toBe("undeclared-workspace-dep");
		expect(process.exitCode).toBe(1);
	});

	it("explains itself outside a workspace", async () => {
		const dir = createTempWorkspace("wscheck");
		writeFiles(dir, { "package.json": JSON.stringify({ name: "solo" }) });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerWorkspaceCheckAction());

		expect(output.stdout()).toContain("no workspace packages found");
	});
});
