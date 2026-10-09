import type { ApplyResult } from "../../core/setup/apply.js";
import { renderDiff } from "../../core/setup/diff.js";
import type { RepositoryFacts } from "../../core/setup/discover.js";
import type { SetupAction } from "../../core/setup/plan.js";
import { getColors } from "../visuals/color.js";
import type { Printer } from "../visuals/printer.js";
import { getPrinter } from "../visuals/printer.js";
import { plural } from "./labels.js";
import { lines } from "./writer.js";

export function renderFacts(
	facts: RepositoryFacts,
	printer: Printer = getPrinter(),
): void {
	const { green, dim } = getColors();
	const found = (text: string) => `${green("✓")} ${text}`;
	const absent = (text: string) => `${dim("·")} ${dim(text)}`;

	lines(
		printer,
		"",
		facts.packageManager === null
			? absent("no lockfile; assuming npm")
			: found(`${facts.packageManager} detected`),
		facts.workspacePackages > 0
			? found(
					`${plural(facts.workspacePackages, "workspace package")} discovered`,
				)
			: absent("not a workspace"),
		...(facts.taskRunner === null
			? []
			: [
					found(
						`${facts.taskRunner === "turborepo" ? "Turborepo" : "Nx"} detected`,
					),
				]),
		facts.vitestConfigs.length > 0
			? found(`Vitest detected (${facts.vitestConfigs.join(", ")})`)
			: facts.vitestWithoutConfig.length + facts.viteConfigs.length > 0
				? found(
						`Vitest detected, with no Vitest config (${[...facts.vitestWithoutConfig.map((dir) => dir || "the root"), ...facts.viteConfigs].join(", ")})`,
					)
				: absent("no Vitest found at the root or in a workspace package"),
		...(facts.jestConfigs.length > 0 ? [found("Jest detected")] : []),
		...(facts.playwrightConfigs.length > 0
			? [found("Playwright detected")]
			: []),
		facts.workflows.length > 0
			? found(
					`GitHub Actions detected (${plural(facts.workflows.length, "workflow")})`,
				)
			: absent("no GitHub Actions workflows"),
		facts.defaultBranch === null
			? absent("no default branch found")
			: found(`default branch: ${facts.defaultBranch}`),
	);
}

/** Every proposed change, with the lines it would add or remove. */
export function renderPlan(
	actions: readonly SetupAction[],
	printer: Printer = getPrinter(),
): void {
	const { bold, green, red, yellow } = getColors();
	const changes = actions.filter((action) => action.kind !== "note");

	if (changes.length === 0) {
		lines(printer, "", "Nothing to change: this repository is already set up.");
	}

	for (const action of actions) {
		if (action.kind === "install") {
			lines(
				printer,
				"",
				`${bold("Run")} ${action.command.join(" ")}`,
				`  ${action.reason}`,
			);
		} else if (action.kind === "write") {
			lines(
				printer,
				"",
				`${bold(action.before === null ? "Create" : "Edit")} ${action.file}`,
				`  ${action.reason}`,
			);
			if (action.before === null) {
				// In full: a file nobody has seen cannot be agreed to by its
				// line count.
				for (const line of action.after.trimEnd().split("\n")) {
					lines(printer, green(`  + ${line}`));
				}
			} else {
				for (const line of renderDiff(action.before, action.after)) {
					lines(
						printer,
						line.startsWith("  +")
							? green(line)
							: line.startsWith("  -")
								? red(line)
								: line,
					);
				}
			}
		} else {
			lines(printer, "", `${yellow("Note:")} ${action.lines[0] ?? ""}`);
			for (const line of action.lines.slice(1)) lines(printer, `  ${line}`);
		}
	}
}

export function renderApplied(
	result: ApplyResult,
	actions: readonly SetupAction[],
	printer: Printer = getPrinter(),
): void {
	const install = actions.find((action) => action.kind === "install");
	lines(printer, "");
	for (const file of result.written) lines(printer, `Wrote ${file}`);
	if (result.installed) lines(printer, "Installed @blzsky/variant");
	if (result.installError !== undefined && install?.kind === "install") {
		lines(
			printer,
			`The install did not finish (${result.installError}). Run it yourself: ${install.command.join(" ")}`,
		);
	}
	const unchecked = actions.some(
		(action) => action.kind === "note" && action.gap === true,
	);
	lines(
		printer,
		"",
		unchecked
			? "The pull-request report is set up. Test runs are not checked yet: see the note above."
			: "variant is configured. Your test command and your pull requests are all you need from here.",
	);
}
