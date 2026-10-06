import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	aliasesInScope,
	matchPathAlias,
	toPathAliases,
} from "../tsconfig-paths.js";

const CWD = path.resolve("/repo");
const abs = (...segments: string[]) => path.resolve(CWD, ...segments);

describe("toPathAliases", () => {
	it("has nothing to do when the config declares no paths", () => {
		expect(toPathAliases(CWD, undefined, undefined)).toEqual([]);
	});

	it("splits a wildcard pattern around its star", () => {
		const [alias] = toPathAliases(CWD, { "@/*": [abs("src/*")] }, CWD);

		expect(alias).toMatchObject({
			prefix: "@/",
			suffix: "",
			wildcard: true,
			targets: ["src/*"],
		});
	});

	it("keeps the text after a star as a suffix to match", () => {
		const [alias] = toPathAliases(
			CWD,
			{ "@/*.css": [abs("styles/*.css")] },
			CWD,
		);

		expect(alias).toMatchObject({ prefix: "@/", suffix: ".css" });
	});

	it("treats a star-free pattern as an exact alias", () => {
		const [alias] = toPathAliases(
			CWD,
			{ "@config": [abs("src/config/index.ts")] },
			CWD,
		);

		expect(alias).toMatchObject({ wildcard: false, prefix: "@config" });
	});

	it("rebases targets onto the workspace root", () => {
		const [alias] = toPathAliases(
			CWD,
			{ "@/*": [abs("packages/app/src/*")] },
			CWD,
		);

		expect(alias?.targets).toEqual(["packages/app/src/*"]);
	});

	it("drops a target outside the workspace, which can never be indexed", () => {
		expect(
			toPathAliases(CWD, { "@/*": [path.resolve("/elsewhere/src/*")] }, CWD),
		).toEqual([]);
	});

	it("keeps the in-workspace targets of a partly-external alias", () => {
		const [alias] = toPathAliases(
			CWD,
			{ "@/*": [path.resolve("/elsewhere/*"), abs("src/*")] },
			CWD,
		);

		expect(alias?.targets).toEqual(["src/*"]);
	});

	it("ignores a pattern with more than one star, which TypeScript rejects too", () => {
		expect(toPathAliases(CWD, { "@/*/*": [abs("src/*")] }, CWD)).toEqual([]);
	});

	it("orders the most specific prefix first", () => {
		const aliases = toPathAliases(
			CWD,
			{ "@/*": [abs("src/*")], "@/lib/*": [abs("src/lib/*")] },
			CWD,
		);

		expect(aliases.map((a) => a.prefix)).toEqual(["@/lib/", "@/"]);
	});
});

// Each package of a workspace can declare its own `paths`, and the same
// alias (`@/*`) usually means a different directory in each.
describe("aliasesInScope", () => {
	const root = toPathAliases(CWD, { "@/*": ["src/*"] }, CWD);
	const web = toPathAliases(
		CWD,
		{ "@/*": ["./src/*"] },
		abs("apps/web"),
		"apps/web",
	);
	const docs = toPathAliases(
		CWD,
		{ "@/*": ["./src/*"] },
		abs("apps/docs"),
		"apps/docs",
	);
	const all = [...root, ...docs, ...web];

	it("offers the nearest tsconfig's alias before the workspace's own", () => {
		expect(
			matchPathAlias("@/lib/x", aliasesInScope("apps/web/src/page.ts", all)),
		).toEqual(["apps/web/src/lib/x", "src/lib/x"]);
	});

	it("leaves out an alias declared for another package", () => {
		expect(
			matchPathAlias("@/lib/x", aliasesInScope("apps/docs/src/page.ts", all)),
		).toEqual(["apps/docs/src/lib/x", "src/lib/x"]);
	});

	it("applies only the workspace's own aliases outside every package", () => {
		expect(
			matchPathAlias("@/lib/x", aliasesInScope("src/page.ts", all)),
		).toEqual(["src/lib/x"]);
	});

	it("does not take a sibling directory with the same prefix as in scope", () => {
		expect(
			matchPathAlias("@/lib/x", aliasesInScope("apps/web-admin/a.ts", all)),
		).toEqual(["src/lib/x"]);
	});
});

describe("matchPathAlias", () => {
	const aliases = toPathAliases(
		CWD,
		{
			"@/*": [abs("app/*")],
			"@/lib/*": [abs("src/lib/*"), abs("vendor/lib/*")],
			"#config": [abs("src/config/index.ts")],
		},
		CWD,
	);

	it("substitutes the captured segment into the target", () => {
		expect(matchPathAlias("@/utils/date", aliases)).toContain("app/utils/date");
	});

	it("offers every target of an alias, in declaration order", () => {
		expect(matchPathAlias("@/lib/parse", aliases).slice(0, 2)).toEqual([
			"src/lib/parse",
			"vendor/lib/parse",
		]);
	});

	it("offers the more specific alias before the general one", () => {
		const bases = matchPathAlias("@/lib/parse", aliases);

		// Both `@/lib/*` and `@/*` match; the longer prefix must win.
		expect(bases).toEqual([
			"src/lib/parse",
			"vendor/lib/parse",
			"app/lib/parse",
		]);
	});

	it("matches an exact alias only on the whole specifier", () => {
		expect(matchPathAlias("#config", aliases)).toEqual(["src/config/index.ts"]);
		expect(matchPathAlias("#config/extra", aliases)).toEqual([]);
	});

	it("returns nothing for a specifier no alias covers", () => {
		expect(matchPathAlias("react", aliases)).toEqual([]);
	});

	it("does not match a specifier too short to contain prefix and suffix", () => {
		const suffixed = toPathAliases(
			CWD,
			{ "@/*.css": [abs("styles/*.css")] },
			CWD,
		);

		expect(matchPathAlias("@.css", suffixed)).toEqual([]);
	});

	it("lets the wildcard match nothing, as TypeScript does", () => {
		const suffixed = toPathAliases(
			CWD,
			{ "@/*.css": [abs("styles/*.css")] },
			CWD,
		);

		expect(matchPathAlias("@/.css", suffixed)).toEqual(["styles/.css"]);
	});
});
