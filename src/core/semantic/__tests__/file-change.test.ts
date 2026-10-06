import path from "node:path";
import { describe, expect, it } from "vitest";
import { toWorkspaceRelative } from "../file-change.js";

describe("toWorkspaceRelative", () => {
	const cwd = path.resolve("/repo");

	it.each([
		["a parent-relative path", "../elsewhere/index.ts"],
		["an absolute path outside it", path.resolve("/elsewhere/index.ts")],
	])("rejects %s", (_, filePath) => {
		expect(() => toWorkspaceRelative(cwd, filePath)).toThrow(
			expect.objectContaining({ code: "CLI_USAGE" }),
		);
	});

	it("leaves an already-relative POSIX path alone", () => {
		expect(toWorkspaceRelative(cwd, "src/index.ts")).toBe("src/index.ts");
	});

	it("relativizes an absolute path against the workspace root", () => {
		expect(toWorkspaceRelative(cwd, path.join(cwd, "src", "index.ts"))).toBe(
			"src/index.ts",
		);
	});

	// git pathspecs are POSIX-separated on every host; a backslash path makes
	// `git show` fail, which the empty-baseline fallback hides as a false
	// "breaking" classification.
	it("normalizes host separators to POSIX", () => {
		const nested = path.join("packages", "ui", "src", "index.ts");
		expect(toWorkspaceRelative(cwd, nested)).toBe("packages/ui/src/index.ts");
	});

	it("collapses redundant segments", () => {
		expect(toWorkspaceRelative(cwd, "./src/../src/index.ts")).toBe(
			"src/index.ts",
		);
	});
});
