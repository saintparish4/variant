/**
 * @module
 * The defaults and template behind `variant init --tasks`. The command owns the
 * prompting; everything it suggests and everything it writes is decided here.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface TaskScaffold {
	name: string;
	command: string;
	inputs: string[];
}

export const DEFAULT_TASK_INPUTS: Record<string, string[]> = {
	build: ["src/**/*", "package.json"],
	lint: ["src/**/*", "*.config.*"],
	test: ["src/**/*", "**/__tests__/**/*"],
	typecheck: ["src/**/*", "tsconfig*.json"],
	format: ["src/**/*"],
};

/** Offered in this order, so a generated config reads the same everywhere. */
const TASK_ORDER = ["build", "lint", "test", "typecheck", "format"];

const FALLBACK_TASKS = ["build", "lint", "test"];

export function inputsFor(task: string): string[] {
	return DEFAULT_TASK_INPUTS[task] ?? DEFAULT_TASK_INPUTS["build"] ?? [];
}

function runPrefix(pm: string): string {
	return pm === "pnpm" || pm === "yarn" ? pm : "npm run";
}

/** How to invoke a framework binary directly, bypassing a package script. */
function binaryRunner(pm: string): string {
	if (pm === "pnpm") return "pnpm";
	if (pm === "yarn") return "yarn";
	return "npx";
}

export function defaultCommandFor(
	pm: string,
	task: string,
	framework: string | null,
): string {
	if (task === "build" && framework === "next") {
		return `${binaryRunner(pm)} next build`;
	}
	if (task === "build" && framework === "vite") {
		return `${binaryRunner(pm)} vite build`;
	}
	return `${runPrefix(pm)} ${task}`;
}

/**
 * The scripts already in package.json, narrowed to ones variant knows how
 * to orchestrate. Falls back to a sensible trio when package.json is missing
 * or unreadable — init must still produce a usable config.
 */
export async function detectScriptTasks(cwd: string): Promise<string[]> {
	try {
		const manifest = JSON.parse(
			await readFile(path.join(cwd, "package.json"), "utf8"),
		) as { scripts?: Record<string, string> };
		const present = new Set(Object.keys(manifest.scripts ?? {}));
		const ordered = TASK_ORDER.filter((task) => present.has(task));
		return ordered.length > 0 ? ordered : [...FALLBACK_TASKS];
	} catch {
		return [...FALLBACK_TASKS];
	}
}

export function renderConfigTemplate(tasks: readonly TaskScaffold[]): string {
	const taskLines = tasks
		.map(
			({ name, command, inputs }) =>
				`    ${name}: {\n      command: "${command}",\n      inputs: [${inputs.map((i) => `"${i}"`).join(", ")}],\n    }`,
		)
		.join(",\n");

	return `import { defineConfig } from "@blzsky/variant";

export default defineConfig({
  strategy: "adaptive",
  tasks: {
${taskLines},
  },
});
`;
}
