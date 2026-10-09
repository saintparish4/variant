/**
 * @module
 * Carries out the changes `plan.ts` proposed. The only place `variant init`
 * writes a file or runs a command.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SetupAction } from "./plan.js";

export interface ApplyDeps {
	/** Run a command in the repository. Throws when it fails. */
	run: (command: readonly string[], cwd: string) => Promise<void>;
}

async function runCommand(
	command: readonly string[],
	cwd: string,
): Promise<void> {
	const [file, ...args] = command;
	if (file === undefined) return;
	const { execa } = await import("execa");
	await execa(file, args, { cwd, stdio: "inherit" });
}

export interface ApplyResult {
	written: string[];
	installed: boolean;
	/** The install command failed; files were still written. */
	installError?: string;
}

/**
 * Files first, then the install. A failed install then leaves a complete
 * setup that only lacks the dependency, with one command to run, instead of a
 * dependency and no setup.
 */
export async function applySetup(
	cwd: string,
	actions: readonly SetupAction[],
	deps: ApplyDeps = { run: runCommand },
): Promise<ApplyResult> {
	const result: ApplyResult = { written: [], installed: false };

	for (const action of actions) {
		if (action.kind !== "write") continue;
		const target = path.join(cwd, action.file);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, action.after);
		result.written.push(action.file);
	}

	for (const action of actions) {
		if (action.kind !== "install") continue;
		try {
			await deps.run(action.command, cwd);
			result.installed = true;
		} catch (error) {
			result.installError =
				(error instanceof Error ? error.message : String(error)).split(
					"\n",
				)[0] ?? "the install command failed";
		}
	}

	return result;
}
