import { defineConfig } from "./src/index.js";

// variant dogfooding itself. Run `node dist/cli.js build` to typecheck + test
// + bundle in one DAG:
//
//   build  →  typecheck
//          →  test
//
// Strategy is `adaptive`, so unchanged inputs produce a cache hit and the task
// is skipped — the whole point of the tool.

export default defineConfig({
	strategy: "adaptive",
	tasks: {
		typecheck: {
			command: "npm run typecheck",
			inputs: ["src/**/*.ts", "tsconfig.json"],
		},
		test: {
			command: "npm run test:run",
			inputs: ["src/**/*.ts", "tsconfig.json"],
		},
		build: {
			command: "npm run build",
			dependsOn: ["typecheck", "test"],
			inputs: [
				"src/**/*.ts",
				"package.json",
				"tsconfig.json",
				"tsup.config.ts",
			],
		},
	},
});
