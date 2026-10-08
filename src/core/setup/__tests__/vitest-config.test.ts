import { describe, expect, it } from "vitest";
import { withAdapter } from "../vitest-config.js";

async function edited(
	source: string,
	fileName = "vitest.config.ts",
): Promise<string> {
	const result = await withAdapter(source, fileName);
	if (result.kind !== "edited") {
		throw new Error(`expected an edit, got ${JSON.stringify(result)}`);
	}
	return result.text;
}

describe("withAdapter", () => {
	it("adds reporters to a config that names none", async () => {
		expect(
			await edited(
				[
					'import { defineConfig } from "vitest/config";',
					"",
					"export default defineConfig({",
					"\ttest: {",
					"\t\tglobals: true,",
					"\t},",
					"});",
					"",
				].join("\n"),
			),
		).toBe(
			[
				'import { defineConfig } from "vitest/config";',
				'import variant from "@blzsky/variant/vitest";',
				"",
				"export default defineConfig({",
				"\ttest: {",
				'\t\treporters: ["default", variant()],',
				"\t\tglobals: true,",
				"\t},",
				"});",
				"",
			].join("\n"),
		);
	});

	it("appends to the reporters a config already lists", async () => {
		const text = await edited(
			[
				'import { defineConfig } from "vitest/config";',
				"export default defineConfig({",
				'  test: { reporters: ["default", "junit"] },',
				"});",
			].join("\n"),
		);
		expect(text).toContain('reporters: ["default", "junit", variant()]');
	});

	it("adds a test block to a config that has none", async () => {
		const text = await edited(
			[
				'import { defineConfig } from "vitest/config";',
				"export default defineConfig({",
				"  plugins: [],",
				"});",
			].join("\n"),
		);
		expect(text).toMatch(
			/test: \{\s+reporters: \["default", variant\(\)\],?\s+\}/,
		);
	});

	it("follows a config through mergeConfig, a variable and a function", async () => {
		for (const source of [
			'import base from "./vite.config";\nimport { defineConfig, mergeConfig } from "vitest/config";\nexport default mergeConfig(base, defineConfig({ test: { globals: true } }));',
			'import { defineConfig } from "vitest/config";\nconst config = defineConfig({ test: { globals: true } });\nexport default config;',
			'import { defineConfig } from "vitest/config";\nexport default defineConfig(() => ({ test: { globals: true } }));',
			"export default { test: { globals: true } };",
		]) {
			expect(await edited(source)).toContain(
				'reporters: ["default", variant()]',
			);
		}
	});

	it("keeps single quotes in a config written with them", async () => {
		const text = await edited(
			"import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { globals: true } });",
		);
		expect(text).toContain("import variant from '@blzsky/variant/vitest';");
		expect(text).toContain("reporters: ['default', variant()]");
	});

	it("uses the named export when the config already has a `variant`", async () => {
		const text = await edited(
			'import { defineConfig } from "vitest/config";\nconst variant = process.env.VARIANT;\nexport default defineConfig({ test: { name: variant } });',
		);
		expect(text).toContain(
			'import { variantReporter } from "@blzsky/variant/vitest";',
		);
		expect(text).toContain('reporters: ["default", variantReporter()]');
	});

	it("does nothing to a config that already has the adapter", async () => {
		expect(
			await withAdapter(
				'import variant from "@blzsky/variant/vitest";\nexport default { test: { reporters: [variant()] } };',
				"vitest.config.ts",
			),
		).toEqual({ kind: "present" });
	});

	it.each([
		[
			"a CommonJS config",
			"module.exports = { test: {} };",
			"vitest.config.cjs",
		],
		[
			"a config built by a function with statements",
			'import { defineConfig } from "vitest/config";\nexport default defineConfig(() => { const x = 1; return { test: {} }; });',
			"vitest.config.ts",
		],
		[
			"reporters that come from a variable",
			'const reporters = ["default"];\nexport default { test: { reporters } };',
			"vitest.config.ts",
		],
		[
			"a test option that comes from elsewhere",
			'import { test } from "./shared";\nexport default { test };',
			"vitest.config.ts",
		],
	])("leaves %s alone and says why", async (_, source, fileName) => {
		const result = await withAdapter(source, fileName);
		expect(result.kind).toBe("manual");
	});
});
