import { describe, expect, it } from "vitest";
import {
	exportsCandidates,
	resolveExportsSubpath,
	toSourceCandidates,
} from "../package-exports.js";

describe("resolveExportsSubpath", () => {
	it("has nothing to say when the package declares no exports", () => {
		expect(resolveExportsSubpath(undefined, "")).toEqual([]);
	});

	it("reads the string sugar form as the package root", () => {
		expect(resolveExportsSubpath("./src/index.ts", "")).toEqual([
			"src/index.ts",
		]);
	});

	it("does not let the sugar form answer for a subpath", () => {
		expect(resolveExportsSubpath("./src/index.ts", "date")).toEqual([]);
	});

	it("resolves the root subpath key", () => {
		expect(resolveExportsSubpath({ ".": "./dist/index.js" }, "")).toEqual([
			"dist/index.js",
		]);
	});

	it("resolves an explicit subpath key", () => {
		expect(
			resolveExportsSubpath(
				{ ".": "./dist/index.js", "./date": "./dist/date.js" },
				"date",
			),
		).toEqual(["dist/date.js"]);
	});

	it("prefers a source-like condition over the published one", () => {
		expect(
			resolveExportsSubpath(
				{ ".": { source: "./src/index.ts", import: "./dist/index.js" } },
				"",
			)[0],
		).toBe("src/index.ts");
	});

	it("follows nested condition objects", () => {
		expect(
			resolveExportsSubpath(
				{ ".": { node: { import: "./dist/index.mjs" } } },
				"",
			),
		).toEqual(["dist/index.mjs"]);
	});

	it("takes every entry of a fallback array", () => {
		expect(
			resolveExportsSubpath({ ".": ["./src/index.ts", "./dist/index.js"] }, ""),
		).toEqual(["src/index.ts", "dist/index.js"]);
	});

	it("expands a wildcard subpath", () => {
		expect(
			resolveExportsSubpath({ "./*": "./dist/*.js" }, "utils/date"),
		).toEqual(["dist/utils/date.js"]);
	});

	it("prefers the most specific wildcard pattern", () => {
		expect(
			resolveExportsSubpath(
				{ "./*": "./dist/*.js", "./utils/*": "./dist/internal/*.js" },
				"utils/date",
			),
		).toEqual(["dist/internal/date.js"]);
	});

	it("ignores a target that is not package-relative", () => {
		expect(resolveExportsSubpath({ ".": "dist/index.js" }, "")).toEqual([]);
	});

	it("says nothing for a subpath the map does not cover", () => {
		expect(resolveExportsSubpath({ ".": "./dist/index.js" }, "secret")).toEqual(
			[],
		);
	});
});

describe("toSourceCandidates", () => {
	it("maps a build output back to the source tree", () => {
		expect(toSourceCandidates("dist/index.js")).toEqual([
			"src/index",
			"lib/index",
			"source/index",
			"index",
		]);
	});

	it("keeps the nested path when mapping back", () => {
		expect(toSourceCandidates("dist/utils/date.js")).toEqual([
			"src/utils/date",
			"lib/utils/date",
			"source/utils/date",
			"utils/date",
		]);
	});

	it("strips both suffixes of a .d.ts target", () => {
		expect(toSourceCandidates("dist/index.d.ts")).toEqual([
			"src/index",
			"lib/index",
			"source/index",
			"index",
		]);
	});

	it("recognizes the other conventional build directories", () => {
		expect(toSourceCandidates("esm/index.js")).toContain("src/index");
		expect(toSourceCandidates("lib/index.js")).toContain("src/index");
	});

	it("keeps a non-build target whole, probing source roots above it", () => {
		// `src` is not a build directory, so nothing is stripped; the target
		// itself is reached via the empty source root.
		expect(toSourceCandidates("src/index.ts")).toContain("src/index");
	});

	it("treats lib as a build root when it leads the target", () => {
		expect(toSourceCandidates("lib/index.js")).toContain("src/index");
	});
});

describe("exportsCandidates", () => {
	it("offers the target as written before what it was built from", () => {
		const candidates = exportsCandidates({ ".": "./dist/index.js" }, "");

		expect(candidates[0]).toBe("dist/index");
		expect(candidates).toContain("src/index");
		expect(candidates.indexOf("dist/index")).toBeLessThan(
			candidates.indexOf("src/index"),
		);
	});

	it("is empty for a package with no exports, leaving the old guesses in charge", () => {
		expect(exportsCandidates(undefined, "")).toEqual([]);
	});
});
