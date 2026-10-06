#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { VariantError } from "../core/errors.js";
import type { ConcurrencyOpts } from "./parse-opts.js";
import { parseConcurrency } from "./parse-opts.js";
import { renderError, renderUnexpectedError } from "./render/error.js";
import { resolveColorChoice, writeGlobalColorChoice } from "./visuals/color.js";
import { Printer, setGlobalPrinter } from "./visuals/printer.js";

const _dir = dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(
	readFileSync(join(_dir, "..", "package.json"), "utf8"),
) as { version: string };

/** Global output flags, resolved once in the preAction hook below. */
type GlobalVisualOptions = {
	quiet: number;
	verbose: number;
	/** Commander negated option: `--no-progress` sets this to false. */
	progress: boolean;
	/** `--color <when>`, or false when `--no-color` is passed. */
	color?: string | boolean;
};

const countFlag = (_value: string, previous: number) => previous + 1;

const program = new Command()
	.name("variant")
	.description(
		"Change intelligence and task orchestration for TypeScript monorepos",
	)
	.version(_pkg.version)
	.option(
		"-q, --quiet",
		"use quiet output (repeat, e.g. -qq, for silent)",
		countFlag,
		0,
	)
	.option("-v, --verbose", "use verbose output", countFlag, 0)
	.option("--no-progress", "hide progress bars and spinners")
	.addOption(
		new Option("--color <when>", "control colored output").choices([
			"auto",
			"always",
			"never",
		]),
	)
	.option("--no-color", "disable colored output (alias for --color never)")
	.hook("preAction", (thisCommand) => {
		const opts = thisCommand.opts<GlobalVisualOptions>();
		writeGlobalColorChoice(resolveColorChoice({ color: opts.color }));
		setGlobalPrinter(
			Printer.fromFlags({
				quiet: opts.quiet,
				verbose: opts.verbose,
				noProgress: !opts.progress,
			}),
		);
	});

const impactCmd = program
	.command("impact")
	.description(
		"Predict which tests a change requires — report-only; the full suite should still run",
	)
	.option("--base <ref>", "git ref to compare against", "HEAD~1")
	.option("--json", "output the report as JSON")
	.action(async (opts: { base: string; json?: boolean }) => {
		const { registerImpactAction } = await import("./commands/impact.js");
		await registerImpactAction({
			base: opts.base,
			...(opts.json === true && { json: true }),
		});
	});

impactCmd
	.command("verify <report...>")
	.description(
		"Reconcile a logged prediction against one or more Vitest/Jest JSON reports — reports false skips",
	)
	.option("--head-sha <sha>", "reconcile the prediction made at this commit")
	.option("--json", "output the reconciliation as JSON")
	.action(async (reports: string[], _opts: unknown, command: Command) => {
		const { registerImpactVerifyAction } = await import("./commands/impact.js");
		// `impact` defines --json too, and Commander gives a flag both
		// commands share to the parent, whichever side of `verify` it is on.
		const opts = command.optsWithGlobals<{
			headSha?: string;
			json?: boolean;
		}>();
		await registerImpactVerifyAction(reports, {
			...(opts.headSha !== undefined && { headSha: opts.headSha }),
			...(opts.json === true && { json: true }),
		});
	});

program
	.command("diff <file>")
	.description(
		"Classify a TypeScript file change as non-impacting / internal / breaking",
	)
	.option("--base <ref>", "git ref to compare against", "HEAD~1")
	.action(async (file: string, opts: { base: string }) => {
		const { registerDiffAction } = await import("./commands/diff.js");
		await registerDiffAction(file, { base: opts.base });
	});

const workspaceCmd = program
	.command("workspace")
	.description("Workspace-level analysis commands");

workspaceCmd
	.command("check")
	.description(
		"Detect packages importing dependencies they do not declare (CI gate: exits 1 on violations)",
	)
	.option("--json", "output the result as JSON")
	.action(async (opts: { json?: boolean }) => {
		const { registerWorkspaceCheckAction } = await import(
			"./commands/workspace.js"
		);
		await registerWorkspaceCheckAction({
			...(opts.json === true && { json: true }),
		});
	});

const prCmd = program.command("pr").description("PR-aware analysis commands");

prCmd
	.command("check")
	.description(
		"Classify all TypeScript changes in this PR and report a build verdict",
	)
	.option("--base <ref>", "base branch or ref for the PR diff", "main")
	.action(async (opts: { base: string }) => {
		const { registerPrCheckAction } = await import("./commands/pr.js");
		await registerPrCheckAction({ base: opts.base });
	});

prCmd
	.command("report")
	.description("Render `pr check` as a structured JSON or markdown report")
	.option("--base <ref>", "base branch or ref for the PR diff", "main")
	.option("--markdown", "output a markdown summary instead of JSON")
	.option("--output <file>", "write report to file instead of stdout")
	.action(
		async (opts: { base: string; markdown?: boolean; output?: string }) => {
			const { registerPrReportAction } = await import("./commands/pr.js");
			await registerPrReportAction(opts);
		},
	);

program
	.command("build")
	.description("Run the build task")
	.option("-c, --concurrency <n>", "max tasks per DAG level")
	.option(
		"--affected",
		"run only packages affected by changes since baseRef (includes cascade dependents)",
	)
	.option("--dry-run", "print the task plan without executing")
	.action(
		async (
			opts: ConcurrencyOpts & { affected?: boolean; dryRun?: boolean },
		) => {
			const { registerBuildAction } = await import("./commands/build.js");
			const concurrency = parseConcurrency(opts);
			await registerBuildAction({
				...(concurrency !== undefined && { concurrency }),
				...(opts.affected && { affected: true }),
				...(opts.dryRun && { dryRun: true }),
			});
		},
	);

program
	.command("run <task>")
	.description("Run a named task")
	.option(
		"-c, --concurrency <n>",
		"max tasks to run concurrently per DAG level",
	)
	.option("--dry-run", "print the task plan without executing")
	.action(
		async (taskName: string, opts: ConcurrencyOpts & { dryRun?: boolean }) => {
			const { registerRunAction } = await import("./commands/run.js");
			const concurrency = parseConcurrency(opts);
			await registerRunAction(taskName, {
				...(concurrency !== undefined && { concurrency }),
				...(opts.dryRun && { dryRun: true }),
			});
		},
	);

program
	.command("init")
	.description("Scaffold variant.config.ts in the current directory")
	.action(async () => {
		const { registerInitAction } = await import("./commands/init.js");
		await registerInitAction();
	});

program
	.command("doctor")
	.description("Validate config and diagnose common issues")
	.action(async () => {
		const { registerDoctorAction } = await import("./commands/doctor.js");
		await registerDoctorAction();
	});

program
	.command("insight")
	.description("Show task timing and cache hit stats")
	.action(async () => {
		const { registerInsightAction } = await import("./commands/insight.js");
		await registerInsightAction();
	});

program
	.command("env")
	.description(
		"Show detected environment (runtime, package manager, framework)",
	)
	.action(async () => {
		const { registerEnvAction } = await import("./commands/env.js");
		await registerEnvAction();
	});

program
	.command("check")
	.description("Validate config and task graph (no execution)")
	.action(async () => {
		const { registerCheckAction } = await import("./commands/check.js");
		await registerCheckAction();
	});

// A reader that stops early (`variant impact --json | head`) closes the pipe
// while variant is still writing, and the next write fails: EPIPE, or EOF on
// Windows. That is the reader's choice, not a failure, but Node's default is
// to crash with a stack trace. Ignore it so the command still finishes with
// its own exit code; later writes to the closed stream are dropped.
for (const stream of [process.stdout, process.stderr]) {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE" && error.code !== "EOF") throw error;
	});
}

// The only place the process exits on error: typed VariantErrors are the
// expected failure mode (exit 1); anything else escaped a typed path and is a
// bug worth a distinct exit code (exit 2).
program.parseAsync(process.argv).catch((err: unknown) => {
	if (err instanceof VariantError) {
		renderError(err);
		process.exit(1);
	}
	renderUnexpectedError(err);
	process.exit(2);
});
