import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectFramework } from "../framework.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-fw-det-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

describe("detectFramework", () => {
	it("returns next adapter when next is in dependencies", async () => {
		const dir = makeTmpDir();
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ dependencies: { next: "14.0.0" } }),
		);
		const result = await detectFramework(dir);
		expect(result?.name).toBe("next");
	});

	it("returns vite adapter when vite is in dependencies (no next)", async () => {
		const dir = makeTmpDir();
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { vite: "5.0.0" } }),
		);
		const result = await detectFramework(dir);
		expect(result?.name).toBe("vite");
	});

	it("next wins over vite when both are present (priority order)", async () => {
		const dir = makeTmpDir();
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				dependencies: { next: "14.0.0" },
				devDependencies: { vite: "5.0.0" },
			}),
		);
		const result = await detectFramework(dir);
		expect(result?.name).toBe("next");
	});

	it("returns null when no known framework detected", async () => {
		const dir = makeTmpDir();
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ dependencies: { express: "4.0.0" } }),
		);
		const result = await detectFramework(dir);
		expect(result).toBeNull();
	});

	it("returns null when no package.json exists", async () => {
		const dir = makeTmpDir();
		const result = await detectFramework(dir);
		expect(result).toBeNull();
	});
});
