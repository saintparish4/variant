import { describe, expect, it } from "vitest";
import { toImportAliases } from "../package-imports.js";
import { matchPathAlias } from "../tsconfig-paths.js";

describe("toImportAliases", () => {
	it("maps an exact subpath import to its file, scoped to the package", () => {
		const aliases = toImportAliases("apps/factory", {
			"#factory-image": "./agent/lib/factory-image.ts",
		});

		expect(aliases).toEqual([
			{
				prefix: "#factory-image",
				suffix: "",
				wildcard: false,
				targets: ["apps/factory/agent/lib/factory-image.ts"],
				scope: "apps/factory",
			},
		]);
	});

	it("substitutes the captured segment of a pattern", () => {
		const aliases = toImportAliases("packages/ui", {
			"#internal/*": "./src/internal/*.js",
		});

		expect(matchPathAlias("#internal/theme", aliases)).toEqual([
			"packages/ui/src/internal/theme.js",
		]);
	});

	it("offers every condition's target, since any of them may be the source", () => {
		const aliases = toImportAliases("", {
			"#config": { node: "./src/config.node.ts", default: "./src/config.ts" },
		});

		expect(matchPathAlias("#config", aliases)).toEqual([
			"src/config.node.ts",
			"src/config.ts",
		]);
		expect(aliases[0]?.scope).toBeUndefined();
	});

	it("leaves out an entry that points at another package", () => {
		expect(toImportAliases("", { "#dep": "lodash" })).toEqual([]);
	});

	it.each([
		undefined,
		null,
		"./index.js",
		[],
	])("has nothing to do for a manifest whose imports field is %j", (field) => {
		expect(toImportAliases("", field)).toEqual([]);
	});

	it("ignores a key that is not a subpath import", () => {
		expect(toImportAliases("", { "./x": "./src/x.ts" })).toEqual([]);
	});
});
