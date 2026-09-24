#!/usr/bin/env node
/**
 * Regenerates the terminal demos in docs/assets/ from real CLI output.
 *
 *   pnpm build && node scripts/record-demos.mjs
 *
 * Builds examples/monorepo into a throwaway git repository, runs the built
 * dist/cli.js against it, writes each session as an asciinema cast, and
 * renders it to a GIF with agg (https://github.com/asciinema/agg), which must
 * be on PATH. Nothing is typed by hand: if the CLI's output changes, rerun this
 * and the demos follow.
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");
const assets = path.join(root, "docs", "assets");

const COLUMNS = 100;
const TYPING_DELAY = 0.045;
const PROMPT = "\u001b[1;32m$\u001b[0m ";

// Fixed identity and dates make every commit SHA, and so every frame,
// identical from one run to the next.
const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "demo",
	GIT_AUTHOR_EMAIL: "demo@example.com",
	GIT_COMMITTER_NAME: "demo",
	GIT_COMMITTER_EMAIL: "demo@example.com",
	GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function run(cwd, file, args) {
	try {
		return execFileSync(file, args, {
			cwd,
			env: gitEnv,
			encoding: "utf8",
		});
	} catch (error) {
		// `workspace check` exits 1 on a violation, which is the point of
		// recording it; its stdout is still the output to show.
		if (typeof error.stdout === "string" && error.status === 1) {
			return error.stdout;
		}
		throw error;
	}
}

function git(cwd, ...args) {
	return run(cwd, "git", args);
}

function writeFile(cwd, relativePath, content) {
	writeFileSync(path.join(cwd, relativePath), content);
}

function createWorkspace() {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-demo-"));
	cpSync(path.join(root, "examples", "monorepo"), dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "initial");
	git(dir, "switch", "-q", "-c", "feat/currency");

	writeFile(
		dir,
		"packages/utils/src/slug.ts",
		`/** Lowercase a title and join its words with hyphens, for use in URLs. */\n${readFileSync(path.join(dir, "packages/utils/src/slug.ts"), "utf8")}`,
	);
	git(dir, "commit", "-q", "-am", "docs: document slugify");

	writeFile(
		dir,
		"packages/utils/src/price.ts",
		[
			"export function formatPrice(cents: number, currency: string): string {",
			'\treturn new Intl.NumberFormat("en-US", { style: "currency", currency }).format(',
			"\t\tcents / 100,",
			"\t);",
			"}",
			"",
		].join("\n"),
	);
	git(dir, "commit", "-q", "-am", "feat: format prices in any currency");
	return dir;
}

function addUndeclaredImport(dir) {
	writeFile(
		dir,
		"packages/shop/src/product.ts",
		[
			'import { postUrl } from "@acme/blog";',
			"",
			"export function productStoryUrl(name: string): string {",
			"\treturn postUrl(name);",
			"}",
			"",
		].join("\n"),
	);
}

/**
 * One demo is a list of steps: the command line as displayed, and the real
 * command that produces its output. The display says `variant` because that
 * is what a user types; the process run is the freshly built dist/cli.js.
 */
function record(dir, steps) {
	const events = [];
	let time = 0.3;
	let rows = 1;
	for (const { display, output } of steps) {
		events.push([time, "o", PROMPT]);
		for (const char of display) {
			time += TYPING_DELAY;
			events.push([time, "o", char]);
		}
		time += 0.4;
		events.push([time, "o", "\r\n"]);
		const text = output(dir).replace(/\n$/, "");
		time += 0.6;
		events.push([time, "o", `${text.replaceAll("\n", "\r\n")}\r\n`]);
		time += 1.2;
		rows += text.split("\n").length + 1;
	}
	events.push([time, "o", PROMPT]);
	const header = {
		version: 2,
		width: COLUMNS,
		height: rows,
		env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
	};
	return [header, ...events].map((line) => JSON.stringify(line)).join("\n");
}

const variant =
	(...args) =>
	(dir) =>
		run(dir, process.execPath, [cli, "--color", "always", ...args]);

const demos = {
	impact: [
		{
			display: "git diff main --stat",
			output: (dir) =>
				git(dir, "-c", "color.ui=always", "diff", "main", "--stat"),
		},
		{
			display: "variant impact --base main",
			output: variant("impact", "--base", "main"),
		},
	],
	"pr-check": [
		{
			display: "variant pr check --base main",
			output: variant("pr", "check", "--base", "main"),
		},
	],
	"workspace-check": [
		{
			display: "variant workspace check",
			output: (dir) => {
				addUndeclaredImport(dir);
				return variant("workspace", "check")(dir);
			},
		},
	],
};

if (!existsSync(cli)) {
	console.error("dist/cli.js is missing. Run `pnpm build` first.");
	process.exit(1);
}

for (const [name, steps] of Object.entries(demos)) {
	const dir = createWorkspace();
	try {
		const cast = path.join(dir, `${name}.cast`);
		writeFileSync(cast, record(dir, steps));
		const gif = path.join(assets, `${name}.gif`);
		run(root, "agg", [
			"--theme",
			"github-dark",
			"--font-size",
			"16",
			"--last-frame-duration",
			"6",
			cast,
			gif,
		]);
		console.log(`wrote ${path.relative(root, gif)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
