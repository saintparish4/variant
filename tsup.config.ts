import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		cli: "src/cli/index.ts",
		vitest: "src/reporters/vitest.ts",
	},
	format: ["esm"],
	dts: true,
	clean: true,
	shims: false,
	target: "node20",
});
