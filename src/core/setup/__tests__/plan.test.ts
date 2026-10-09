import { describe, expect, it } from "vitest";
import { diffLines, renderDiff } from "../diff.js";
import { adapterTargets } from "../discover.js";
import { installCommand } from "../plan.js";

describe("installCommand", () => {
	it.each([
		["npm", 0, ["npm", "install", "--save-dev", "@blzsky/variant"]],
		["pnpm", 0, ["pnpm", "add", "--save-dev", "@blzsky/variant"]],
		["yarn", 0, ["yarn", "add", "--dev", "@blzsky/variant"]],
		["bun", 0, ["bun", "add", "--dev", "@blzsky/variant"]],
	] as const)("adds a dev dependency with %s", (packageManager, workspacePackages, expected) => {
		expect(installCommand({ packageManager, workspacePackages })).toEqual(
			expected,
		);
	});

	// Both refuse to add to a workspace root unless told it is on purpose.
	it.each([
		["pnpm", "--workspace-root"],
		["yarn", "--ignore-workspace-root-check"],
	] as const)("tells %s the workspace root is meant", (packageManager, flag) => {
		expect(installCommand({ packageManager, workspacePackages: 3 })).toContain(
			flag,
		);
	});

	it("falls back to npm when nothing says which manager is used", () => {
		expect(
			installCommand({ packageManager: null, workspacePackages: 0 })[0],
		).toBe("npm");
	});

	it("installs what it is told to, for a build that is not published", () => {
		expect(
			installCommand(
				{ packageManager: "pnpm", workspacePackages: 0 },
				"./variant.tgz",
			),
		).toEqual(["pnpm", "add", "--save-dev", "./variant.tgz"]);
	});
});

describe("adapterTargets", () => {
	it("uses the root config alone, since its reporters cover every project", () => {
		expect(
			adapterTargets(
				["vitest.config.ts", "packages/a/vitest.config.ts"],
				["packages/a"],
			),
		).toEqual(["vitest.config.ts"]);
	});

	it("uses each workspace package's config when there is no root one", () => {
		expect(
			adapterTargets(
				["packages/a/vitest.config.ts", "packages/b/vitest.config.ts"],
				["packages/a", "packages/b"],
			),
		).toEqual(["packages/a/vitest.config.ts", "packages/b/vitest.config.ts"]);
	});

	it("leaves out configs that belong to no workspace package", () => {
		expect(
			adapterTargets(
				["examples/basic/vitest.config.ts", "packages/a/vitest.config.ts"],
				["packages/a"],
			),
		).toEqual(["packages/a/vitest.config.ts"]);
	});
});

describe("renderDiff", () => {
	it("marks added and removed lines and keeps a little context", () => {
		const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
		const after = ["a", "b", "c", "X", "e", "f", "g"].join("\n");

		expect(renderDiff(before, after)).toEqual([
			"    b",
			"    c",
			"  - d",
			"  + X",
			"    e",
			"    f",
		]);
	});

	it("marks where unchanged lines were left out between two changes", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
		const after = [...lines];
		after[1] = "changed 1";
		after[10] = "changed 10";

		expect(renderDiff(lines.join("\n"), after.join("\n"))).toContain("    …");
	});

	it("reports no difference for identical text", () => {
		expect(
			diffLines("a\nb", "a\nb").every((line) => line.kind === "same"),
		).toBe(true);
	});
});
