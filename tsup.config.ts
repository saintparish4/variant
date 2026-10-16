import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: {
			index: "src/index.ts",
			cli: "src/cli/index.ts",
			vitest: "src/reporters/vitest.ts",
			// `variant check` runs Stryker in a process of its own, and Stryker
			// loads the reporter by path; both are found beside the CLI.
			"stryker-host": "src/adapters/mutation/stryker-host.ts",
			"stryker-plugins": "src/adapters/mutation/stryker-plugins.ts",
		},
		format: ["esm"],
		dts: true,
		// The two builds run at once, so neither may clean: one would delete
		// what the other had just written. `pnpm build` empties dist/ first.
		clean: false,
		shims: false,
		target: "node22",
	},
	// A test config is loaded by its runner, and in a package without
	// `"type": "module"` Vite bundles it as CommonJS and `require`s what it
	// imports. Shipped as ESM only, the adapter could not be loaded there and
	// the user's own test run failed at startup.
	{
		entry: { vitest: "src/reporters/vitest.ts" },
		format: ["cjs"],
		dts: true,
		clean: false,
		// `import.meta.url` locates the CLI beside this file.
		shims: true,
		target: "node22",
	},
]);
