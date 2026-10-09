import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { findVariantConfigPath } from "../../core/config/loader.js";
import { detectProject } from "../../core/detection/project.js";
import type { TaskScaffold } from "../../core/scaffold/config-template.js";
import {
	defaultCommandFor,
	detectScriptTasks,
	inputsFor,
	renderConfigTemplate,
} from "../../core/scaffold/config-template.js";
import { applySetup } from "../../core/setup/apply.js";
import { discoverRepository } from "../../core/setup/discover.js";
import { PACKAGE_NAME, planSetup } from "../../core/setup/plan.js";
import { renderApplied, renderFacts, renderPlan } from "../render/init.js";
import { lines } from "../render/writer.js";
import { getPrinter } from "../visuals/printer.js";
import { confirm } from "../visuals/prompts.js";

const CONFIG_FILENAME = "variant.config.ts";

function splitList(answer: string): string[] {
	return answer
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export interface InitActionOptions {
	/** Show what would change and stop. */
	dryRun?: boolean;
	/** Apply without asking. Required when there is no terminal to ask in. */
	yes?: boolean;
	/** False leaves installing the package to the user. */
	install?: boolean;
	/** What to install in place of the published package: a tarball, a version. */
	package?: string;
	/** Write `variant.config.ts` for the task runner instead. */
	tasks?: boolean;
	/**
	 * The version of variant that is running. It is what gets installed:
	 * under a registry tag such as `canary`, the bare package name would
	 * resolve to `latest`, which is another program.
	 */
	version?: string;
}

/**
 * Set variant up in a repository: find out how it installs, tests and runs
 * CI, show the changes that wire variant in, and make them once confirmed.
 * After this nobody has to run a variant command.
 */
export async function registerInitAction(
	opts: InitActionOptions = {},
): Promise<void> {
	if (opts.tasks === true) return registerInitTasksAction();

	const cwd = process.cwd();
	const printer = getPrinter();

	const facts = await discoverRepository(cwd);
	renderFacts(facts);

	const packageSpec =
		opts.package ??
		(opts.version === undefined
			? undefined
			: `${PACKAGE_NAME}@${opts.version}`);
	const actions = await planSetup(cwd, facts, {
		...(packageSpec !== undefined && { packageSpec }),
		...(opts.install === false && { install: false }),
	});
	renderPlan(actions);
	if (!actions.some((action) => action.kind !== "note")) return;

	if (opts.dryRun === true) {
		lines(printer, "", "Dry run: nothing was changed.");
		return;
	}
	if (opts.yes !== true) {
		// No terminal means nobody can read the diff and agree to it.
		if (process.stdin.isTTY !== true) {
			lines(
				printer,
				"",
				"Nothing was changed. Run `variant init --yes` to apply these changes.",
			);
			return;
		}
		lines(printer, "");
		if (!(await confirm("Apply these changes?"))) {
			lines(printer, "Nothing was changed.");
			return;
		}
	}

	renderApplied(await applySetup(cwd, actions), actions);
}

/** `variant init --tasks`: the config the frozen task runner reads. */
async function registerInitTasksAction(): Promise<void> {
	const cwd = process.cwd();
	const printer = getPrinter();

	const existing = findVariantConfigPath(cwd);
	if (existing) {
		lines(
			printer,
			`${path.basename(existing)} already exists — nothing written.`,
		);
		return;
	}

	const [{ pm, framework }, detectedScripts] = await Promise.all([
		detectProject(cwd),
		detectScriptTasks(cwd),
	]);
	const pmName = pm.name;
	const frameworkName = framework?.name ?? null;
	const destination = path.join(cwd, CONFIG_FILENAME);

	if (!process.stdin.isTTY) {
		const build: TaskScaffold = {
			name: "build",
			command: defaultCommandFor(pmName, "build", frameworkName),
			inputs: inputsFor("build"),
		};
		await writeFile(destination, renderConfigTemplate([build]));
		lines(
			printer,
			`Created ${CONFIG_FILENAME} (non-interactive, detected ${pmName}${frameworkName ? `/${frameworkName}` : ""})`,
		);
		return;
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		lines(
			printer,
			"",
			`Detected: ${pmName}${frameworkName ? ` · ${frameworkName}` : ""} · scripts: ${detectedScripts.join(", ")}`,
			"",
		);

		const answeredTasks = await rl.question(
			`Tasks to configure [${detectedScripts.join(",")}]: `,
		);
		const taskNames = answeredTasks.trim()
			? splitList(answeredTasks)
			: detectedScripts;

		const tasks: TaskScaffold[] = [];
		for (const name of taskNames) {
			const suggestedCommand = defaultCommandFor(pmName, name, frameworkName);
			const answeredCommand = await rl.question(
				`  Command for "${name}" [${suggestedCommand}]: `,
			);
			const suggestedInputs = inputsFor(name);
			const answeredInputs = await rl.question(
				`  Inputs for "${name}" [${suggestedInputs.join(", ")}]: `,
			);
			tasks.push({
				name,
				command: answeredCommand.trim() || suggestedCommand,
				inputs: answeredInputs.trim()
					? splitList(answeredInputs)
					: suggestedInputs,
			});
		}

		await writeFile(destination, renderConfigTemplate(tasks));
		lines(
			printer,
			"",
			`Created ${CONFIG_FILENAME} — run \`variant doctor\` to verify.`,
		);
	} finally {
		rl.close();
	}
}
