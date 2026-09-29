/**
 * Boundary: a prediction is a function of the tree and the base, nothing
 * else. Not of the order git lists changed files in, not of whether the
 * symbol index was warm, and not of the run. Shadow-mode data is compared
 * across runs and repositories, so a report that varies with any of these
 * cannot be measured.
 */

import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { renderImpactJson } from "../../cli/render/impact.js";
import type { ImpactPrediction } from "../../core/history/impact-log.js";
import {
	defaultHistoryDir,
	readImpactPredictions,
} from "../../core/history/impact-log.js";
import { predictImpact } from "../../core/impact/predict.js";
import { defaultGraphDir } from "../../core/semantic/symbol-graph.js";
import {
	captureOutput,
	cleanupTempWorkspaces,
	createTempWorkspace,
	writeFiles,
} from "../helpers/cli-harness.js";
import { seededRandom } from "../helpers/seeded-random.js";

const BASE: Record<string, string> = {
	"packages/core/src/auth.ts":
		"export function login(name: string): string { return name; }",
	"packages/core/src/format.ts":
		"export const format = (n: number): string => n.toFixed(2);",
	"packages/core/src/theme.css": ".a { color: red; }",
	"packages/web/src/page.ts":
		"export const title = (): string => 'home';\nexport const size = 1;",
};

const HEAD: Record<string, string> = {
	"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
	"packages/core/package.json": JSON.stringify({
		name: "core",
		version: "0.0.1",
	}),
	"packages/web/package.json": JSON.stringify({
		name: "web",
		version: "0.0.1",
		dependencies: { core: "workspace:*" },
	}),
	"packages/core/src/auth.ts":
		"export function login(name: string, strict: boolean): string { return strict ? name : name.trim(); }",
	"packages/core/src/format.ts":
		"export const format = (n: number): string => n.toFixed(3);",
	"packages/core/src/theme.css": ".a { color: blue; }",
	"packages/core/src/styles.ts": 'import "./theme.css";\nexport const s = 1;',
	"packages/core/src/i18n.ts": `export const load = (lang: string) => import(\`./locales/\${lang}.js\`);`,
	"packages/core/src/locales/en.ts": 'export const hello = "hello";',
	"packages/core/src/auth.test.ts":
		'import { login } from "./auth.js";\nexport const t = login("a", true);',
	"packages/core/src/format.test.ts":
		'import { format } from "./format.js";\nexport const t = format(1);',
	"packages/core/src/styles.test.ts":
		'import { s } from "./styles.js";\nexport const t = s;',
	"packages/web/src/page.ts":
		"// the landing page\nexport const title = (): string => 'home';\nexport const size = 1;",
	"packages/web/src/app.ts":
		'import { login } from "core/src/auth.js";\nimport { title } from "./page.js";\nexport const boot = (): string => login(title(), false);',
	"packages/web/src/app.test.ts":
		'import { boot } from "./app.js";\nexport const t = boot();',
	"packages/web/src/page.test.ts":
		'import { title } from "./page.js";\nexport const t = title();',
	"README.md": "# fixture\n",
};

const CHANGED = [
	"packages/core/src/auth.ts",
	"packages/core/src/format.ts",
	"packages/core/src/theme.css",
	"packages/core/src/locales/en.ts",
	"packages/web/src/page.ts",
	"README.md",
];

async function predict(
	dir: string,
	changedFiles: readonly string[],
): Promise<{ json: string; record: Omit<ImpactPrediction, "at"> }> {
	const report = await predictImpact(dir, {
		changedFiles: [...changedFiles],
		readBefore: async (relPath) => BASE[relPath] ?? null,
		headSha: "0000000000000000000000000000000000000000",
	});
	const output = captureOutput();
	renderImpactJson(report, output.printer);

	const records = await readImpactPredictions(defaultHistoryDir(dir));
	const last = records.at(-1);
	if (last === undefined) throw new Error("no prediction was logged");
	const { at: _, ...record } = last;
	return { json: output.stdout(), record };
}

function workspace(): string {
	const dir = createTempWorkspace("determinism");
	writeFiles(dir, HEAD);
	return dir;
}

afterEach(() => {
	cleanupTempWorkspaces();
});

describe("impact determinism", () => {
	it("the same inputs twice give byte-identical JSON and history records", async () => {
		const dir = workspace();

		const cold = await predict(dir, CHANGED);
		const warm = await predict(dir, CHANGED);

		expect(warm.json).toBe(cold.json);
		expect(JSON.stringify(warm.record)).toBe(JSON.stringify(cold.record));
		// The fixture reaches every kind of change, so this compares a real
		// prediction rather than two empty ones.
		const report = JSON.parse(cold.json) as {
			tests: { affectedTests: string[]; totalTests: number };
		};
		expect(report.tests.totalTests).toBe(5);
		expect(report.tests.affectedTests.length).toBeGreaterThan(0);
	});

	it("any order of the changed files gives the same result", async () => {
		const dir = workspace();
		const sorted = await predict(dir, CHANGED);

		for (const seed of [1, 2, 3]) {
			const shuffled = await predict(dir, seededRandom(seed).shuffle(CHANGED));
			expect(shuffled.json, `seed ${seed}`).toBe(sorted.json);
			expect(JSON.stringify(shuffled.record), `seed ${seed}`).toBe(
				JSON.stringify(sorted.record),
			);
		}
	});

	it("a rebuilt symbol index gives the same result as a warm one", async () => {
		const dir = workspace();
		await predict(dir, CHANGED);
		const warm = await predict(dir, CHANGED);

		rmSync(defaultGraphDir(dir), { recursive: true, force: true });
		const rebuilt = await predict(dir, CHANGED);

		expect(rebuilt.json).toBe(warm.json);
		expect(JSON.stringify(rebuilt.record)).toBe(JSON.stringify(warm.record));
	});

	it("the same tree in another directory gives the same result", async () => {
		const first = await predict(workspace(), CHANGED);
		const second = await predict(workspace(), CHANGED);

		expect(second.json).toBe(first.json);
	});
});
