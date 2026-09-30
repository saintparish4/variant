#!/usr/bin/env node
/**
 * Commit replay: shadow mode run after the fact over real history.
 *
 * For each target in accuracy/targets.json, clone the repository, and for
 * each of its last N first-parent commits up to the pinned SHA:
 *   1. check the commit out and predict with `variant impact --base <parent>`;
 *   2. install (only when the lockfile changed) and run the setup commands;
 *   3. run the full suite, the way the repository's CI does, writing Vitest
 *      JSON reports;
 *   4. reconcile with `variant impact verify`, as impact-shadow.yml does.
 *
 * The prediction comes from this checkout's dist/cli.js, so every target is
 * measured with the same build. The prediction is made before install and
 * build, on a clean tree, so nothing those steps write can join the diff.
 *
 * Usage:
 *   pnpm build && pnpm accuracy                # every target
 *   node accuracy/replay.mjs --target pyra     # one target
 *   node accuracy/replay.mjs --work-dir /data  # where the clones live
 *
 * Results: accuracy/results/<target>.json, <target>.reconciliation.jsonl, and
 * latest.md, regenerated from every <target>.json present.
 */
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");
const resultsDir = join(repoRoot, "accuracy", "results");
const targetsPath = join(repoRoot, "accuracy", "targets.json");

/** Each Vitest process writes this, relative to the package it runs in. */
const REPORT_NAME = ".vitest-report.json";
/** A hung install or suite must not stall the whole replay. */
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

function log(message) {
	console.error(message);
}

function fail(message) {
	console.error(`accuracy: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const options = {
		target: undefined,
		workDir: join(tmpdir(), "variant-accuracy"),
	};
	for (let i = 0; i < argv.length; i++) {
		const argument = argv[i];
		if (argument === "--target") {
			options.target = argv[++i];
		} else if (argument === "--work-dir") {
			options.workDir = resolve(argv[++i] ?? "");
		} else {
			fail(
				`unknown option "${argument}" — supported: --target <name>, --work-dir <dir>`,
			);
		}
	}
	return options;
}

function run(argv, cwd, { allowFailure = false } = {}) {
	const [command, ...args] = argv;
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		timeout: COMMAND_TIMEOUT_MS,
		// The environment GitHub Actions gives a suite, and nothing more: an
		// extra variable reaches the target's tests too, and NO_COLOR once
		// failed variant's own color tests at every commit.
		env: { ...process.env, CI: "true" },
	});
	const ok = result.status === 0;
	if (!ok && !allowFailure) {
		const detail = (
			result.stderr ||
			result.stdout ||
			String(result.error ?? "")
		)
			.trim()
			.split("\n")
			.slice(-5)
			.join("\n");
		throw new Error(`${argv.join(" ")} failed in ${cwd}\n${detail}`);
	}
	return {
		ok,
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function git(cwd, ...args) {
	return run(["git", ...args], cwd).stdout.trim();
}

function ensureClone(target, dir) {
	if (!existsSync(join(dir, ".git"))) {
		log(`  cloning ${target.repo}`);
		mkdirSync(dirname(dir), { recursive: true });
		run(
			["git", "clone", "--quiet", "--filter=blob:none", target.repo, dir],
			tmpdir(),
		);
	}
	if (
		!run(["git", "cat-file", "-e", `${target.sha}^{commit}`], dir, {
			allowFailure: true,
		}).ok
	) {
		run(["git", "fetch", "--quiet", "origin", target.sha], dir);
	}
}

/** Oldest first, each with its first parent; a root commit has none and is left out. */
function commitsToReplay(dir, target) {
	return git(
		dir,
		"rev-list",
		"--first-parent",
		`--max-count=${target.commits}`,
		target.sha,
	)
		.split("\n")
		.reverse()
		.flatMap((sha) => {
			const parent = run(
				["git", "rev-parse", "--verify", "--quiet", `${sha}^1`],
				dir,
				{
					allowFailure: true,
				},
			).stdout.trim();
			return parent === "" ? [] : [{ sha, parent }];
		});
}

/** Report files anywhere outside node_modules and .git. */
function findReports(dir, found = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) findReports(full, found);
		else if (entry.name === REPORT_NAME) found.push(full);
	}
	return found;
}

/**
 * The lockfile's blob at a commit decides whether to reinstall. Reinstalling
 * every commit would cost more than the rest of the replay together.
 */
function lockfileKey(dir, sha) {
	for (const lockfile of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
		const blob = run(
			["git", "rev-parse", "--verify", "--quiet", `${sha}:${lockfile}`],
			dir,
			{
				allowFailure: true,
			},
		).stdout.trim();
		if (blob !== "") return `${lockfile}:${blob}`;
	}
	return "none";
}

/**
 * The prediction seen from the runner's side: of the test files the suite
 * actually ran, how many it would have run, and for how long. variant's own
 * test count can include files the runner never runs (helpers under
 * `__tests__/`, projects the runner config excludes), and a skip rate over
 * that count would overstate what skipping saves.
 *
 * Durations are per-file sums, not wall time: runners overlap files across
 * workers, so this estimates the test time a skip would save, not minutes.
 */
function runnerView(testResults, dir, selected, selectAll) {
	let wouldRun = 0;
	let full = 0;
	let predicted = 0;
	for (const entry of testResults) {
		const duration = Math.max(0, (entry.endTime ?? 0) - (entry.startTime ?? 0));
		full += duration;
		const file = relative(dir, entry.name).replace(/\\/g, "/");
		if (selectAll || selected.has(file)) {
			wouldRun++;
			predicted += duration;
		}
	}
	return {
		runnerTestFiles: testResults.length,
		wouldRun,
		fullMs: Math.round(full),
		predictedMs: Math.round(predicted),
	};
}

function replayCommit(target, dir, commit, state) {
	const row = { sha: commit.sha, parent: commit.parent };
	git(dir, "checkout", "--quiet", "--force", "--detach", commit.sha);
	// -x removes build output too; node_modules is kept so an unchanged
	// lockfile needs no install, and .variant/graph so the index stays warm,
	// as a CI cache would keep it.
	git(dir, "clean", "-fdxq", "-e", "node_modules", "-e", ".variant");

	const predicted = run(
		["node", cliPath, "impact", "--base", commit.parent, "--json"],
		dir,
		{
			allowFailure: true,
		},
	);
	if (!predicted.ok) {
		row.error = `impact: ${predicted.stderr.trim().split("\n")[0] ?? "failed"}`;
		return row;
	}
	const prediction = JSON.parse(predicted.stdout);
	row.changedFiles = prediction.radius.changed.length;
	row.predictedTests = prediction.tests.affectedTests.length;
	row.totalTests = prediction.tests.totalTests;
	row.selectAll = prediction.tests.selectAll;
	row.confidence = prediction.tests.confidence;
	row.resolution = prediction.tests.resolution;

	const key = lockfileKey(dir, commit.sha);
	try {
		if (key !== state.installedKey) {
			log("    install");
			run(target.install, dir);
			state.installedKey = key;
		}
		for (const step of target.setup) {
			log(`    ${step.join(" ")}`);
			run(step, dir);
		}
	} catch (error) {
		state.installedKey = undefined;
		row.error = `setup: ${String(error.message).split("\n")[0]}`;
		return row;
	}

	log("    full suite");
	for (const stale of findReports(dir)) rmSync(stale);
	run(target.test, dir, { allowFailure: true });
	const reports = findReports(dir);
	if (reports.length === 0) {
		row.error = "the test command wrote no report";
		return row;
	}
	const testResults = reports.flatMap(
		(report) => JSON.parse(readFileSync(report, "utf8")).testResults ?? [],
	);
	const merged = join(state.scratch, `${target.name}-report.json`);
	writeFileSync(merged, JSON.stringify({ testResults }));

	const verified = run(
		[
			"node",
			cliPath,
			"impact",
			"verify",
			merged,
			"--head-sha",
			commit.sha,
			"--json",
		],
		dir,
		{ allowFailure: true },
	);
	if (!verified.ok) {
		row.error = `verify: ${verified.stderr.trim().split("\n")[0] ?? "failed"}`;
		return row;
	}
	const reconciliation = JSON.parse(verified.stdout);
	row.failedTests = reconciliation.failedTests.length;
	row.caught = reconciliation.caught.length;
	row.falseSkips = reconciliation.falseSkips.length;
	row.failedFiles = reconciliation.failedTests;
	row.falseSkipped = reconciliation.falseSkips;
	Object.assign(
		row,
		runnerView(
			testResults,
			dir,
			new Set(prediction.tests.affectedTests),
			row.selectAll,
		),
	);
	return row;
}

function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * A false skip of a file that also failed at the parent commit hid no new
 * breakage: the failure was already there. It still counts toward the gate,
 * which makes no such exception, but the two read differently, so they are
 * reported apart. Unknowable when the parent was not replayed.
 */
function markPreexisting(rows) {
	const failedAt = new Map(
		rows
			.filter((row) => row.failedFiles !== undefined)
			.map((row) => [row.sha, new Set(row.failedFiles)]),
	);
	for (const row of rows) {
		if (row.falseSkipped === undefined) continue;
		const atParent = failedAt.get(row.parent);
		row.preexistingFalseSkips =
			atParent === undefined
				? null
				: row.falseSkipped.filter((file) => atParent.has(file)).length;
	}
}

function falseSkipCell(row) {
	return row.preexistingFalseSkips > 0
		? `${row.falseSkips} (${row.preexistingFalseSkips} already failing)`
		: String(row.falseSkips);
}

function summarize(rows) {
	const replayed = rows.filter((row) => row.error === undefined);
	const failed = replayed.reduce((sum, row) => sum + row.failedTests, 0);
	const falseSkips = replayed.reduce((sum, row) => sum + row.falseSkips, 0);
	return {
		commits: rows.length,
		replayed: replayed.length,
		errors: rows.length - replayed.length,
		runsWithFailures: replayed.filter((row) => row.failedTests > 0).length,
		failedTests: failed,
		falseSkips,
		preexistingFalseSkips: replayed.reduce(
			(sum, row) => sum + (row.preexistingFalseSkips ?? 0),
			0,
		),
		falseSkipRate: failed === 0 ? null : falseSkips / failed,
		selectAll: replayed.filter((row) => row.selectAll).length,
		medianSkipRate: median(
			replayed
				.filter((row) => row.runnerTestFiles > 0)
				.map((row) => 1 - row.wouldRun / row.runnerTestFiles),
		),
		resolution: Object.fromEntries(
			["high", "medium", "low"].map((bucket) => [
				bucket,
				replayed.filter((row) => row.resolution === bucket).length,
			]),
		),
		testFileMs: {
			full: replayed.reduce((sum, row) => sum + row.fullMs, 0),
			predicted: replayed.reduce((sum, row) => sum + row.predictedMs, 0),
		},
	};
}

function percent(value) {
	return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function seconds(ms) {
	return `${(ms / 1000).toFixed(1)} s`;
}

function renderMarkdown(results) {
	const out = [
		"# Commit replay",
		"",
		"| Target | Commits | Replayed | Runs with failures | Failed test files | False skips | False-skip rate | Median skip | Select-all |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const result of results) {
		const s = result.summary;
		out.push(
			`| ${result.target} | ${s.commits} | ${s.replayed} | ${s.runsWithFailures} | ${s.failedTests} | ${s.falseSkips} | ${percent(s.falseSkipRate)} | ${percent(s.medianSkipRate)} | ${s.selectAll} |`,
		);
	}
	for (const result of results) {
		out.push(
			"",
			`## ${result.target}`,
			"",
			`${result.repo} at \`${result.sha.slice(0, 12)}\`, the last ${result.summary.commits} first-parent commits, oldest first.`,
			"",
			"| Commit | Changed | Selected | Of | Confidence | Runner ran | Would run | Failed | Caught | False skips | Test-file time, predicted / full |",
			"|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|",
		);
		for (const row of result.rows) {
			const sha = `\`${row.sha.slice(0, 7)}\``;
			if (row.error !== undefined) {
				out.push(`| ${sha} | ${row.error} | | | | | | | | | |`);
				continue;
			}
			out.push(
				`| ${sha} | ${row.changedFiles} | ${row.selectAll ? "all" : row.predictedTests} | ${row.totalTests} | ${row.resolution} (${Math.round(row.confidence * 100)}%) | ${row.runnerTestFiles} | ${row.wouldRun} | ${row.failedTests} | ${row.caught} | ${falseSkipCell(row)} | ${seconds(row.predictedMs)} / ${seconds(row.fullMs)} |`,
			);
		}
		const s = result.summary;
		out.push(
			"",
			`False skips already failing at the parent commit: ${s.preexistingFalseSkips} of ${s.falseSkips}. Resolution: ${s.resolution.high} high, ${s.resolution.medium} medium, ${s.resolution.low} low. Test-file time: ${seconds(s.testFileMs.predicted)} predicted of ${seconds(s.testFileMs.full)}.`,
		);
	}
	const first = results[0];
	if (first !== undefined) {
		out.push(
			"",
			`variant ${first.variant.version} (\`${first.variant.commit.slice(0, 7)}\`), Node ${first.environment.node}, ${first.environment.platform}, ${first.environment.cpus} CPUs.`,
		);
	}
	return `${out.join("\n")}\n`;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!existsSync(cliPath))
		fail("dist/cli.js is missing; run `pnpm build` first");
	const targets = JSON.parse(readFileSync(targetsPath, "utf8")).filter(
		(target) => options.target === undefined || target.name === options.target,
	);
	if (targets.length === 0) fail(`no target named "${options.target}"`);
	mkdirSync(resultsDir, { recursive: true });
	mkdirSync(options.workDir, { recursive: true });

	const variant = {
		version: JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
			.version,
		commit: git(repoRoot, "rev-parse", "HEAD"),
	};
	const environment = {
		node: process.version,
		platform: `${platform()} ${release()}`,
		cpus: cpus().length,
	};

	for (const target of targets) {
		log(`${target.name}`);
		const dir = join(options.workDir, target.name);
		ensureClone(target, dir);
		// Only this run's reconciliations belong in its results.
		rmSync(join(dir, ".variant", "history"), { recursive: true, force: true });

		const state = { installedKey: undefined, scratch: options.workDir };
		const rows = [];
		for (const commit of commitsToReplay(dir, target)) {
			log(`  ${commit.sha.slice(0, 7)}`);
			const row = replayCommit(target, dir, commit, state);
			if (row.error !== undefined) log(`    ${row.error}`);
			rows.push(row);
		}
		markPreexisting(rows);

		const reconciliations = join(
			dir,
			".variant",
			"history",
			"reconciliation.jsonl",
		);
		if (existsSync(reconciliations)) {
			copyFileSync(
				reconciliations,
				join(resultsDir, `${target.name}.reconciliation.jsonl`),
			);
		}
		writeFileSync(
			join(resultsDir, `${target.name}.json`),
			`${JSON.stringify(
				{
					target: target.name,
					repo: target.repo,
					sha: target.sha,
					variant,
					environment,
					at: new Date().toISOString(),
					summary: summarize(rows),
					rows,
				},
				null,
				2,
			)}\n`,
		);
	}

	const order = JSON.parse(readFileSync(targetsPath, "utf8")).map(
		(target) => target.name,
	);
	const results = order
		.filter((name) => existsSync(join(resultsDir, `${name}.json`)))
		.map((name) =>
			JSON.parse(readFileSync(join(resultsDir, `${name}.json`), "utf8")),
		);
	const markdown = renderMarkdown(results);
	writeFileSync(join(resultsDir, "latest.md"), markdown);
	process.stdout.write(markdown);
}

main();
