import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ImpactPrediction } from "../impact-log.js";
import {
	appendImpactPrediction,
	defaultHistoryDir,
	MAX_IMPACT_RECORDS,
	readImpactPredictions,
} from "../impact-log.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-history-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// Windows holds directory handles briefly; the OS cleans these up eventually.
		}
	}
	tmpDirs.length = 0;
});

function makePrediction(at: string): ImpactPrediction {
	return {
		at,
		baseRef: "HEAD~1",
		changedFiles: ["src/a.ts"],
		affectedFiles: 2,
		affectedPackages: [],
		affectedTests: ["src/a.test.ts"],
		totalTests: 10,
		selectAll: false,
		verdict: "build-required",
		confidence: 0.9,
		notes: [],
	};
}

describe("impact-log", () => {
	it("round-trips predictions oldest-first", async () => {
		const dir = defaultHistoryDir(makeTmpDir());
		expect(await appendImpactPrediction(dir, makePrediction("t1"))).toBe(true);
		expect(await appendImpactPrediction(dir, makePrediction("t2"))).toBe(true);

		const records = await readImpactPredictions(dir);
		expect(records.map((r) => r.at)).toEqual(["t1", "t2"]);
		expect(records[0]?.affectedTests).toEqual(["src/a.test.ts"]);
	});

	it("returns an empty list when the log is missing", async () => {
		expect(
			await readImpactPredictions(defaultHistoryDir(makeTmpDir())),
		).toEqual([]);
	});

	it("skips corrupt lines instead of failing", async () => {
		const dir = defaultHistoryDir(makeTmpDir());
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "impact.jsonl"),
			`${JSON.stringify(makePrediction("ok"))}\n{truncated-wri\n`,
		);
		const records = await readImpactPredictions(dir);
		expect(records.map((r) => r.at)).toEqual(["ok"]);
	});

	it("caps the log at MAX_IMPACT_RECORDS, dropping the oldest", async () => {
		const dir = defaultHistoryDir(makeTmpDir());
		mkdirSync(dir, { recursive: true });
		const lines = Array.from({ length: MAX_IMPACT_RECORDS + 2 }, (_, i) =>
			JSON.stringify(makePrediction(`t${i}`)),
		);
		writeFileSync(path.join(dir, "impact.jsonl"), `${lines.join("\n")}\n`);

		await appendImpactPrediction(dir, makePrediction("newest"));

		const records = await readImpactPredictions(dir);
		expect(records).toHaveLength(MAX_IMPACT_RECORDS);
		expect(records.at(-1)?.at).toBe("newest");
		// The three oldest entries (t0..t2) fell off the front.
		expect(records[0]?.at).toBe("t3");
	});
});
