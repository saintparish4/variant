import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectPackageManager } from "../packageManager.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-pm-det-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

describe("detectPackageManager", () => {
	it("detects pnpm when pnpm-lock.yaml exists", () => {
		const dir = makeTmpDir();
		writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
		expect(detectPackageManager(dir).name).toBe("pnpm");
	});

	it("detects pnpm when pnpm-workspace.yaml exists (no lockfile)", () => {
		const dir = makeTmpDir();
		writeFileSync(
			path.join(dir, "pnpm-workspace.yaml"),
			"packages:\n  - packages/*\n",
		);
		expect(detectPackageManager(dir).name).toBe("pnpm");
	});

	it("detects yarn when yarn.lock exists", () => {
		const dir = makeTmpDir();
		writeFileSync(path.join(dir, "yarn.lock"), "");
		expect(detectPackageManager(dir).name).toBe("yarn");
	});

	it("detects npm when package-lock.json exists", () => {
		const dir = makeTmpDir();
		writeFileSync(path.join(dir, "package-lock.json"), "{}");
		expect(detectPackageManager(dir).name).toBe("npm");
	});

	it("falls back to npm when no lockfile present", () => {
		const dir = makeTmpDir();
		expect(detectPackageManager(dir).name).toBe("npm");
	});

	it("pnpm wins over yarn when both lockfiles exist", () => {
		const dir = makeTmpDir();
		writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
		writeFileSync(path.join(dir, "yarn.lock"), "");
		expect(detectPackageManager(dir).name).toBe("pnpm");
	});

	it("yarn wins over npm when both lockfiles exist", () => {
		const dir = makeTmpDir();
		writeFileSync(path.join(dir, "yarn.lock"), "");
		writeFileSync(path.join(dir, "package-lock.json"), "{}");
		expect(detectPackageManager(dir).name).toBe("yarn");
	});
});
