import { describe, expect, it } from "vitest";
import { canRewriteTsconfig } from "../tsconfig.js";

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
