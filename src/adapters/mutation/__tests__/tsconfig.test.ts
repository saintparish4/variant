import path from "node:path";
import { describe, expect, it } from "vitest";
import { canRewriteTsconfig, tsconfigLeavesPackage } from "../tsconfig.js";

describe("canRewriteTsconfig", () => {
	it("is true for a TypeScript with the JavaScript API Stryker calls", async () => {
		const typescript6 = { parseConfigFileTextToJson: () => ({ config: {} }) };

		expect(await canRewriteTsconfig(async () => typescript6)).toBe(true);
		expect(
			await canRewriteTsconfig(async () => ({ default: typescript6 })),
		).toBe(true);
	});

	// TypeScript 7 is native and exports almost nothing to JavaScript; every
	// run failed with "ts.parseConfigFileTextToJson is not a function".
	it("is false for TypeScript 7, which has no JavaScript API", async () => {
		expect(
			await canRewriteTsconfig(async () => ({ version: "7.0.2", default: {} })),
		).toBe(false);
	});

	it("is false where there is no TypeScript to load", async () => {
		expect(
			await canRewriteTsconfig(async () => {
				throw new Error("Cannot find module 'typescript'");
			}),
		).toBe(false);
	});
});

describe("tsconfigLeavesPackage", () => {
	const root = path.resolve("/repo/packages/math");
	/** Files relative to the package, as the reader would find them. */
	const files =
		(map: Record<string, string>) =>
		(file: string): string | null => {
			for (const [relative, text] of Object.entries(map)) {
				if (path.join(root, relative) === file) return text;
			}
			return null;
		};

	// turborepo's example extends a package by name, resolved through the
	// linked node_modules: nothing to adjust, so no note.
	it("is false for an extends that names a package", async () => {
		expect(
			await tsconfigLeavesPackage(
				root,
				files({
					"tsconfig.json": '{ "extends": "@repo/typescript-config/base.json" }',
				}),
			),
		).toBe(false);
	});

	it("is true for a relative extends that leaves the package", async () => {
		expect(
			await tsconfigLeavesPackage(
				root,
				files({
					"tsconfig.json":
						'// shared settings\n{ "extends": "../../tsconfig.base.json", }',
				}),
			),
		).toBe(true);
	});

	it("is true for a project reference outside the package", async () => {
		expect(
			await tsconfigLeavesPackage(
				root,
				files({
					"tsconfig.json": '{ "references": [{ "path": "../shared" }] }',
				}),
			),
		).toBe(true);
	});

	it("follows a relative extends that stays inside the package", async () => {
		expect(
			await tsconfigLeavesPackage(
				root,
				files({
					"tsconfig.json": '{ "extends": "./tsconfig.build.json" }',
					"tsconfig.build.json": '{ "extends": "../../base.json" }',
				}),
			),
		).toBe(true);
	});

	it("is false where there is no tsconfig", async () => {
		expect(await tsconfigLeavesPackage(root, files({}))).toBe(false);
	});
});
