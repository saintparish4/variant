/**
 * Boundary: the git layer against a real repository. `core/vcs/git` shells out
 * and `core/cache/git-diff` maps its output onto the package graph — neither
 * claim can be verified without an actual repo and actual commits.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getChangedPackages } from "../../core/cache/git-diff.js";
import { loadPackageGraph } from "../../core/graph/package-graph.js";
import {
	listChangedFiles,
	listChangedFilesSinceMergeBase,
	readFileAtRef,
	readFilesAtRef,
	resolveCommit,
} from "../../core/vcs/git.js";
import {
	cleanupTempWorkspaces,
	createTempWorkspace,
	writeFiles,
} from "../helpers/cli-harness.js";

const IDENTITY = "-c user.email=t@t.com -c user.name=T";

function git(dir: string, command: string): void {
	execSync(`git ${command}`, { cwd: dir, stdio: "ignore" });
}

function commitAll(dir: string, message: string): void {
	git(dir, "add .");
	git(dir, `${IDENTITY} commit -m "${message}"`);
}

/** A two-package repo with one commit; the caller makes the second change. */
function repoWithBaseline(): string {
	const dir = createTempWorkspace("git");
	writeFiles(dir, {
		"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
		"packages/utils/package.json": JSON.stringify({ name: "utils" }),
		"packages/utils/src/index.ts": "export const value = 1;\n",
		"packages/docs/package.json": JSON.stringify({ name: "docs" }),
		"packages/docs/src/index.ts": "export const doc = 1;\n",
	});
	git(dir, "init");
	commitAll(dir, "initial");
	return dir;
}

afterEach(cleanupTempWorkspaces);

describe("readFileAtRef", () => {
	it("returns the file's contents as of the ref", async () => {
		const dir = repoWithBaseline();
		writeFiles(dir, {
			"packages/utils/src/index.ts": "export const value = 2;\n",
		});

		expect(
			await readFileAtRef(dir, "HEAD", "packages/utils/src/index.ts"),
		).toBe("export const value = 1;");
	});

	it("returns null for a file that did not exist at the ref", async () => {
		const dir = repoWithBaseline();
		expect(
			await readFileAtRef(dir, "HEAD", "packages/utils/src/new.ts"),
		).toBeNull();
	});

	it("returns null outside a git repository instead of throwing", async () => {
		const dir = createTempWorkspace("git");
		expect(await readFileAtRef(dir, "HEAD", "anything.ts")).toBeNull();
	});
});

describe("readFilesAtRef", () => {
	it("returns the same contents as the per-file reader", async () => {
		const dir = repoWithBaseline();
		writeFiles(dir, {
			"packages/utils/src/index.ts": "export const value = 2;\n",
		});
		const paths = ["packages/utils/src/index.ts", "packages/docs/src/index.ts"];

		const batch = await readFilesAtRef(dir, "HEAD", paths);

		expect(batch).not.toBeNull();
		for (const relPath of paths) {
			expect(batch?.get(relPath)).toBe(
				await readFileAtRef(dir, "HEAD", relPath),
			);
		}
	});

	it("maps a path missing at the ref to null", async () => {
		const dir = repoWithBaseline();
		const batch = await readFilesAtRef(dir, "HEAD", [
			"packages/utils/src/index.ts",
			"packages/utils/src/added-later.ts",
		]);

		expect(batch?.get("packages/utils/src/index.ts")).toBe(
			"export const value = 1;",
		);
		expect(batch?.get("packages/utils/src/added-later.ts")).toBeNull();
	});

	it("stays aligned across a batch larger than one chunk", async () => {
		const dir = createTempWorkspace("git");
		const files: Record<string, string> = {
			"package.json": JSON.stringify({ name: "many" }),
		};
		for (let i = 0; i < 300; i++) {
			files[`src/m${i}.ts`] = `export const v${i} = ${i};\n`;
		}
		writeFiles(dir, files);
		git(dir, "init");
		commitAll(dir, "many files");
		const paths = Array.from({ length: 300 }, (_, i) => `src/m${i}.ts`);

		const batch = await readFilesAtRef(dir, "HEAD", paths);

		expect(batch?.size).toBe(300);
		for (let i = 0; i < 300; i++) {
			expect(batch?.get(`src/m${i}.ts`)).toBe(`export const v${i} = ${i};`);
		}
	});

	it("preserves multi-byte content", async () => {
		const dir = createTempWorkspace("git");
		writeFiles(dir, {
			"package.json": JSON.stringify({ name: "utf8" }),
			"src/a.ts": 'export const emoji = "🚀 — ünïcode";\n',
			"src/b.ts": "export const plain = 1;\n",
		});
		git(dir, "init");
		commitAll(dir, "utf8");

		const batch = await readFilesAtRef(dir, "HEAD", ["src/a.ts", "src/b.ts"]);

		expect(batch?.get("src/a.ts")).toBe('export const emoji = "🚀 — ünïcode";');
		expect(batch?.get("src/b.ts")).toBe("export const plain = 1;");
	});

	it("returns an empty map for no requests without spawning git", async () => {
		const dir = createTempWorkspace("git");
		expect(await readFilesAtRef(dir, "HEAD", [])).toEqual(new Map());
	});

	it("returns null outside a git repository so the caller can fall back", async () => {
		const dir = createTempWorkspace("git");
		expect(await readFilesAtRef(dir, "HEAD", ["anything.ts"])).toBeNull();
	});

	it("refuses a batch containing a newline in a path", async () => {
		const dir = repoWithBaseline();
		expect(await readFilesAtRef(dir, "HEAD", ["a\nb.ts"])).toBeNull();
	});
});

describe("listChangedFiles", () => {
	it("lists files differing from the ref", async () => {
		const dir = repoWithBaseline();
		writeFiles(dir, {
			"packages/utils/src/index.ts": "export const value = 2;\n",
		});

		expect(await listChangedFiles(dir, "HEAD")).toEqual([
			"packages/utils/src/index.ts",
		]);
	});

	it("returns an empty list when nothing changed", async () => {
		const dir = repoWithBaseline();
		expect(await listChangedFiles(dir, "HEAD")).toEqual([]);
	});

	// With rename detection git names only the new path, and the old one is
	// what the files still importing it are found by.
	it("lists a renamed file under both its old and its new path", async () => {
		const dir = repoWithBaseline();
		git(dir, "mv packages/utils/src/index.ts packages/utils/src/main.ts");
		commitAll(dir, "rename");

		expect(await listChangedFiles(dir, "HEAD~1")).toEqual([
			"packages/utils/src/index.ts",
			"packages/utils/src/main.ts",
		]);
	});

	// Git prints a path with non-ASCII bytes quoted and octal-escaped unless
	// asked not to, and that string names no file.
	it("returns a non-ASCII path as it is on disk", async () => {
		const dir = repoWithBaseline();
		writeFiles(dir, {
			"packages/utils/src/日本語.ts": "export const greeting = 1;\n",
			"packages/utils/src/with space.ts": "export const spaced = 1;\n",
		});
		commitAll(dir, "odd names");
		writeFiles(dir, {
			"packages/utils/src/日本語.ts": "export const greeting = 2;\n",
			"packages/utils/src/with space.ts": "export const spaced = 2;\n",
		});

		const changed = await listChangedFiles(dir, "HEAD");

		expect(changed).toEqual([
			"packages/utils/src/with space.ts",
			"packages/utils/src/日本語.ts",
		]);
		expect(await readFilesAtRef(dir, "HEAD", changed ?? [])).toEqual(
			new Map([
				["packages/utils/src/with space.ts", "export const spaced = 1;"],
				["packages/utils/src/日本語.ts", "export const greeting = 1;"],
			]),
		);
	});

	it("returns null outside a git repository", async () => {
		const dir = createTempWorkspace("git");
		expect(await listChangedFiles(dir, "HEAD")).toBeNull();
	});
});

describe("listChangedFilesSinceMergeBase", () => {
	it("reports only what the branch added, not what the base advanced past", async () => {
		const dir = repoWithBaseline();
		git(dir, "branch base-branch");

		git(dir, "checkout -b feature");
		writeFiles(dir, {
			"packages/utils/src/feature.ts": "export const f = 1;\n",
		});
		commitAll(dir, "feature work");

		// Advance the base branch with an unrelated commit. A two-dot diff would
		// attribute this file to the branch; the three-dot range must not.
		git(dir, "checkout base-branch");
		writeFiles(dir, { "packages/docs/src/other.ts": "export const o = 1;\n" });
		commitAll(dir, "base work");
		git(dir, "checkout feature");

		expect(await listChangedFilesSinceMergeBase(dir, "base-branch")).toEqual([
			"packages/utils/src/feature.ts",
		]);
	});
});

// Git prints and reads paths from the repository root wherever it runs, while
// every caller works relative to its own directory. A project kept in a
// subdirectory is where the two differ: read as-is, each changed file named
// nothing on disk, so it classified as deleted and selected no tests.
describe("a working directory below the repository root", () => {
	it("lists changed files relative to that directory", async () => {
		const dir = repoWithBaseline();
		writeFiles(dir, {
			"packages/utils/src/index.ts": "export const value = 2;\n",
			"packages/docs/src/index.ts": "export const doc = 2;\n",
		});

		expect(
			await listChangedFiles(path.join(dir, "packages/utils"), "HEAD"),
		).toEqual(["../docs/src/index.ts", "src/index.ts"]);
	});

	it("lists a branch's changes relative to that directory", async () => {
		const dir = repoWithBaseline();
		git(dir, "branch base-branch");
		git(dir, "checkout -b feature");
		writeFiles(dir, {
			"packages/utils/src/feature.ts": "export const f = 1;\n",
		});
		commitAll(dir, "feature work");

		expect(
			await listChangedFilesSinceMergeBase(
				path.join(dir, "packages/utils"),
				"base-branch",
			),
		).toEqual(["src/feature.ts"]);
	});

	it("reads a file at a ref by its path from that directory", async () => {
		const dir = repoWithBaseline();
		const cwd = path.join(dir, "packages/utils");

		expect(await readFileAtRef(cwd, "HEAD", "src/index.ts")).toBe(
			"export const value = 1;",
		);
		expect(await readFileAtRef(cwd, "HEAD", "../docs/src/index.ts")).toBe(
			"export const doc = 1;",
		);
	});

	it("reads a batch by paths from that directory", async () => {
		const dir = repoWithBaseline();
		const batch = await readFilesAtRef(
			path.join(dir, "packages/utils"),
			"HEAD",
			["src/index.ts", "../docs/src/index.ts", "src/added-later.ts"],
		);

		expect(batch?.get("src/index.ts")).toBe("export const value = 1;");
		expect(batch?.get("../docs/src/index.ts")).toBe("export const doc = 1;");
		expect(batch?.get("src/added-later.ts")).toBeNull();
	});
});

// A trailing `--` only protects the paths after it: git still parses a ref
// that starts with `-` as an option, and `--output=<file>` makes it write one.
describe("refs that look like options", () => {
	it("never reach git as an option", async () => {
		const dir = repoWithBaseline();
		const planted = path.join(dir, "planted.txt");
		const ref = `--output=${planted}`;

		expect(await listChangedFiles(dir, ref)).toBeNull();
		expect(await listChangedFilesSinceMergeBase(dir, ref)).toBeNull();
		expect(await readFileAtRef(dir, ref, "package.json")).toBeNull();
		expect(await resolveCommit(dir, ref)).toBeNull();
		expect(existsSync(planted)).toBe(false);
	});
});

describe("getChangedPackages", () => {
	it("maps changed files onto the workspace packages that own them", async () => {
		const dir = repoWithBaseline();
		writeFiles(dir, {
			"packages/utils/src/index.ts": "export const value = 2;\n",
		});

		const changed = await getChangedPackages(
			dir,
			await loadPackageGraph(dir),
			"HEAD",
		);

		expect(changed).toEqual(new Set(["utils"]));
	});

	it("returns null when git is unavailable so callers skip the optimization", async () => {
		const dir = createTempWorkspace("git");
		writeFiles(dir, {
			"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
			"packages/solo/package.json": JSON.stringify({ name: "solo" }),
		});

		expect(
			await getChangedPackages(dir, await loadPackageGraph(dir), "HEAD"),
		).toBeNull();
	});
});
