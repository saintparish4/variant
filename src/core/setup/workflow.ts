/**
 * @module
 * What `variant init` does to GitHub Actions workflows: decide which ones run
 * tests, give their checkout the history a prediction needs, and write the
 * workflow that comments on pull requests.
 *
 * Workflows are edited as text, line by line. Parsing and re-serializing YAML
 * would reformat a file its owner wrote by hand and drop their comments.
 */

import type { PackageManagerName } from "./discover.js";

const TEST_COMMAND =
	/\b(?:vitest|jest)\b|\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test\b|\bturbo(?:\s+run)?\s+test\b|\bnx\s+(?:run-many|affected|test)\b/;

/** Whether a workflow runs the test suite, by the commands in it. */
export function runsTests(workflow: string): boolean {
	return workflow
		.split("\n")
		.some((line) => !line.trim().startsWith("#") && TEST_COMMAND.test(line));
}

const CHECKOUT = /^(\s*)(-\s+)?uses:\s*actions\/checkout@\S+\s*$/;

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/**
 * Give every `actions/checkout` step `fetch-depth: 0`. The default is one
 * commit, and a prediction needs the commit it compares against.
 *
 * Returns null when nothing needs changing.
 */
export function withFullHistory(workflow: string): string | null {
	const lines = workflow.split("\n");
	const out: string[] = [];
	let changed = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		out.push(line);
		const match = CHECKOUT.exec(line);
		if (match === null) continue;

		// Keys of the step line up with `uses`, wherever the dash is.
		const keyIndent = (match[1]?.length ?? 0) + (match[2]?.length ?? 0);
		const pad = " ".repeat(keyIndent);

		// The rest of this step: lines indented deeper than the dash, or
		// siblings of `uses` at the same indent.
		let end = i + 1;
		while (end < lines.length) {
			const next = lines[end] ?? "";
			if (next.trim() !== "" && indentOf(next) < keyIndent) break;
			if (next.trim().startsWith("- ") && indentOf(next) < keyIndent) break;
			end++;
		}
		const step = lines.slice(i + 1, end);
		const withAt = step.findIndex(
			(l) => indentOf(l) === keyIndent && /^with:\s*$/.test(l.trim()),
		);

		if (withAt === -1) {
			out.push(`${pad}with:`, `${pad}  fetch-depth: 0`);
			changed = true;
			continue;
		}

		const depthAt = step.findIndex(
			(l, index) =>
				index > withAt &&
				indentOf(l) > keyIndent &&
				/^fetch-depth:/.test(l.trim()),
		);
		for (let j = 0; j < step.length; j++) {
			const stepLine = step[j] ?? "";
			if (j === depthAt) {
				const fixed = stepLine.replace(/fetch-depth:.*$/, "fetch-depth: 0");
				if (fixed !== stepLine) changed = true;
				out.push(fixed);
				continue;
			}
			out.push(stepLine);
			if (j === withAt && depthAt === -1) {
				out.push(`${pad}  fetch-depth: 0`);
				changed = true;
			}
		}
		i = end - 1;
	}

	return changed ? out.join("\n") : null;
}

const SETUP: Record<PackageManagerName, string[]> = {
	npm: [],
	pnpm: ["      - uses: pnpm/action-setup@v4", ""],
	yarn: [],
	bun: ["      - uses: oven-sh/setup-bun@v2", ""],
};

const INSTALL: Record<PackageManagerName, string> = {
	npm: "npm ci",
	pnpm: "pnpm install --frozen-lockfile",
	yarn: "yarn install --frozen-lockfile",
	bun: "bun install --frozen-lockfile",
};

/**
 * How each package manager runs a binary that is already installed. None of
 * these fetch: `npx variant` without `--no` would download an unrelated
 * package named `variant` if the install step were ever removed.
 */
const EXEC: Record<PackageManagerName, string> = {
	npm: "npx --no -- variant",
	pnpm: "pnpm exec variant",
	yarn: "yarn variant",
	bun: "bun run variant",
};

/** setup-node can cache these; it has no cache for bun. */
const NODE_CACHE: Partial<Record<PackageManagerName, string>> = {
	npm: "npm",
	pnpm: "pnpm",
	yarn: "yarn",
};

/** The workflow that keeps one comment on each pull request up to date. */
export function pullRequestWorkflow(
	packageManager: PackageManagerName,
): string {
	const cache = NODE_CACHE[packageManager];
	return [
		"# Written by `variant init`. It keeps one comment on each pull request",
		"# saying what the change affects. It is yours to edit.",
		"",
		"name: variant",
		"",
		"on:",
		"  pull_request:",
		"",
		"permissions:",
		"  contents: read",
		"  pull-requests: write",
		"",
		"jobs:",
		"  report:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - uses: actions/checkout@v7",
		"        with:",
		"          # variant compares against the commit the branch started from.",
		"          fetch-depth: 0",
		"",
		...SETUP[packageManager],
		"      - uses: actions/setup-node@v7",
		"        with:",
		"          node-version: 22",
		...(cache === undefined ? [] : [`          cache: ${cache}`]),
		"",
		`      - run: ${INSTALL[packageManager]}`,
		"",
		"      - name: Describe the pull request",
		`        run: ${EXEC[packageManager]} pr report --markdown --output pr-report.md`,
		"",
		"      - name: Post or update the comment",
		"        # Pull requests from forks get a read-only token and cannot comment.",
		"        if: github.event.pull_request.head.repo.full_name == github.repository",
		"        uses: actions/github-script@v9",
		"        with:",
		"          script: |",
		'            const fs = require("node:fs");',
		'            const body = fs.readFileSync("pr-report.md", "utf8");',
		"            // The first line of every report; it marks the comment to update.",
		'            const marker = "## Variant PR Report";',
		"            const { owner, repo } = context.repo;",
		"            const issue_number = context.issue.number;",
		"            const comments = await github.paginate(github.rest.issues.listComments, {",
		"              owner,",
		"              repo,",
		"              issue_number,",
		"            });",
		"            const existing = comments.find(",
		"              (comment) =>",
		'                comment.user?.login === "github-actions[bot]" &&',
		"                comment.body?.startsWith(marker),",
		"            );",
		"            if (existing) {",
		"              await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });",
		"            } else {",
		"              await github.rest.issues.createComment({ owner, repo, issue_number, body });",
		"            }",
		"",
	].join("\n");
}
