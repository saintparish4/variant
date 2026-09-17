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
import { lines } from "../render/writer.js";
import { getPrinter } from "../visuals/printer.js";

const CONFIG_FILENAME = "variant.config.ts";

function splitList(answer: string): string[] {
	return answer
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export async function registerInitAction(): Promise<void> {
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
