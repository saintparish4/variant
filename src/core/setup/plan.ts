/**
 * @module
 * Turns what `discover.ts` found into the changes `variant init` proposes.
 * Nothing is written here: every change is a value the command can show
 * before it is applied.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PackageManagerName, RepositoryFacts } from "./discover.js";
import { manualInstructions, withAdapter } from "./vitest-config.js";
import { pullRequestWorkflow, withFullHistory } from "./workflow.js";

export type SetupAction =
	/** Run the package manager. */
	| { kind: "install"; command: string[]; reason: string }
	/** Create `file` (`before` null) or change it. */
	| {
			kind: "write";
			file: string;
			before: string | null;
			after: string;
			reason: string;
	  }
	/** Something the user has to know or do; nothing is changed. */
	| { kind: "note"; lines: string[] };

export interface PlanOptions {
	/** What to install; a tarball path or a version, for an unreleased build. */
	packageSpec?: string;
	/** Leave the dependency to the user. */
	install?: boolean;
}

export const PACKAGE_NAME = "@blzsky/variant";
export const PULL_REQUEST_WORKFLOW = ".github/workflows/variant.yml";

const ADD_DEV: Record<PackageManagerName, string[]> = {
	npm: ["npm", "install", "--save-dev"],
	pnpm: ["pnpm", "add", "--save-dev"],
	yarn: ["yarn", "add", "--dev"],
	bun: ["bun", "add", "--dev"],
};

/** pnpm and yarn refuse to add to a workspace root unless told it is meant. */
const WORKSPACE_ROOT_FLAG: Partial<Record<PackageManagerName, string>> = {
	pnpm: "--workspace-root",
	yarn: "--ignore-workspace-root-check",
};

export function installCommand(
	facts: Pick<RepositoryFacts, "packageManager" | "workspacePackages">,
	packageSpec: string = PACKAGE_NAME,
): string[] {
	const packageManager = facts.packageManager ?? "npm";
	const rootFlag =
		facts.workspacePackages > 0
			? WORKSPACE_ROOT_FLAG[packageManager]
			: undefined;
	return [
		...ADD_DEV[packageManager],
		...(rootFlag === undefined ? [] : [rootFlag]),
		packageSpec,
	];
}

function withIgnoreEntry(gitignore: string | null): string {
	if (gitignore === null || gitignore === "") return ".variant/\n";
	return `${gitignore}${gitignore.endsWith("\n") ? "" : "\n"}.variant/\n`;
}

async function readText(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

export async function planSetup(
	cwd: string,
	facts: RepositoryFacts,
	options: PlanOptions = {},
): Promise<SetupAction[]> {
	const actions: SetupAction[] = [];

	if (!facts.hasManifest) {
		return [
			{
				kind: "note",
				lines: [
					"No package.json here. Run `variant init` in the directory that has one.",
				],
			},
		];
	}

	if (!facts.installed && options.install !== false) {
		actions.push({
			kind: "install",
			command: installCommand(facts, options.packageSpec),
			reason: "the adapter is imported from your test config",
		});
	} else if (!facts.installed) {
		actions.push({
			kind: "note",
			lines: [
				`${PACKAGE_NAME} is not installed. The adapter needs it: ${installCommand(facts, options.packageSpec).join(" ")}`,
			],
		});
	}

	for (const file of facts.vitestConfigs) {
		const before = await readText(path.join(cwd, file));
		if (before === null) continue;
		const edit = await withAdapter(before, file);
		if (edit.kind === "edited") {
			actions.push({
				kind: "write",
				file,
				before,
				after: edit.text,
				reason: "predict and check on every CI test run",
			});
		} else if (edit.kind === "manual") {
			actions.push({
				kind: "note",
				lines: [
					`${file} was left alone: ${edit.reason}.`,
					...manualInstructions(file),
				],
			});
		}
	}
	if (facts.vitestConfigs.length === 0 && facts.jestConfigs.length === 0) {
		actions.push({
			kind: "note",
			lines: [
				"No Vitest config found at the root or in a workspace package, so no adapter was added.",
				...manualInstructions("your Vitest config"),
			],
		});
	}
	if (facts.jestConfigs.length > 0) {
		actions.push({
			kind: "note",
			lines: [
				`Jest found (${facts.jestConfigs.join(", ")}). There is no Jest adapter yet, so Jest runs are not checked.`,
			],
		});
	}

	if (!facts.ignoresVariantDir) {
		const before = await readText(path.join(cwd, ".gitignore"));
		actions.push({
			kind: "write",
			file: ".gitignore",
			before,
			after: withIgnoreEntry(before),
			reason: "variant keeps its index and history in .variant/",
		});
	}

	for (const workflow of facts.workflows) {
		if (!workflow.runsTests || !workflow.shallow) continue;
		const after = withFullHistory(workflow.content);
		if (after === null) continue;
		actions.push({
			kind: "write",
			file: workflow.file,
			before: workflow.content,
			after,
			reason:
				"the adapter compares against an earlier commit, and the default checkout fetches only one",
		});
	}

	if (!facts.workflows.some((w) => w.file === PULL_REQUEST_WORKFLOW)) {
		actions.push({
			kind: "write",
			file: PULL_REQUEST_WORKFLOW,
			before: null,
			after: pullRequestWorkflow(facts.packageManager ?? "npm"),
			reason: "one comment on each pull request saying what it affects",
		});
	}

	return actions;
}
