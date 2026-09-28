/**
 * Boundary: `verifyImpact` meeting a real prediction log, a real report file,
 * and the reconciliation log it appends to. The judgement itself is unit-tested
 * in `core/impact/__tests__/verify.test.ts`; what is proved here is that the
 * three files line up.
 */

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImpactReportError } from "../../core/errors.js";
import type { ImpactPrediction } from "../../core/history/impact-log.js";
import {
	appendImpactPrediction,
	defaultHistoryDir,
	readReconciliations,
} from "../../core/history/impact-log.js";
import { verifyImpact } from "../../core/impact/verify.js";
import {
	cleanupTempWorkspaces,
	createTempWorkspace,
	writeFiles,
} from "../helpers/cli-harness.js";

afterEach(() => {
	cleanupTempWorkspaces();
});

function prediction(overrides: Partial<ImpactPrediction>): ImpactPrediction {
	return {
		at: "2026-01-01T00:00:00.000Z",
		baseRef: "HEAD~1",
		headSha: "a".repeat(40),
		changedFiles: ["src/math.ts"],
		affectedFiles: 1,
		affectedPackages: [],
		affectedTests: ["src/math.test.ts"],
		totalTests: 2,
		selectAll: false,
		verdict: "build-recommended",
		confidence: 1,
		notes: [],
		...overrides,
	};
}

function writeReport(
	dir: string,
	name: string,
	failing: readonly string[],
): string {
	writeFiles(dir, {
		[name]: JSON.stringify({
			testResults: failing.map((file) => ({
				name: path.join(dir, file),
				status: "failed",
			})),
		}),
	});
	return name;
}

describe("verifyImpact", () => {
	it("returns null when nothing has been predicted yet", async () => {
		const dir = createTempWorkspace("verify");
		const report = writeReport(dir, "report.json", []);

		expect(await verifyImpact(dir, report)).toBeNull();
	});

	it("reconciles the most recent prediction by default", async () => {
		const dir = createTempWorkspace("verify");
		await appendImpactPrediction(defaultHistoryDir(dir), prediction({}));
		const report = writeReport(dir, "report.json", ["src/math.test.ts"]);

		const result = await verifyImpact(dir, report);

		expect(result?.matchedBy).toBe("most-recent");
		expect(result?.caught).toEqual(["src/math.test.ts"]);
		expect(result?.falseSkips).toEqual([]);
	});

	it("reports a failure the prediction did not select as a false skip", async () => {
		const dir = createTempWorkspace("verify");
		await appendImpactPrediction(defaultHistoryDir(dir), prediction({}));
		const report = writeReport(dir, "report.json", ["src/format.test.ts"]);

		const result = await verifyImpact(dir, report);

		expect(result?.falseSkips).toEqual(["src/format.test.ts"]);
		expect(result?.falseSkipRate).toBe(1);
	});

	it("matches the prediction made at a given commit, not the newest one", async () => {
		const dir = createTempWorkspace("verify");
		const historyDir = defaultHistoryDir(dir);
		await appendImpactPrediction(
			historyDir,
			prediction({
				headSha: "b".repeat(40),
				affectedTests: ["src/old.test.ts"],
			}),
		);
		await appendImpactPrediction(
			historyDir,
			prediction({
				headSha: "c".repeat(40),
				affectedTests: ["src/new.test.ts"],
			}),
		);
		const report = writeReport(dir, "report.json", ["src/old.test.ts"]);

		const result = await verifyImpact(dir, report, {
			headSha: "b".repeat(40),
		});

		expect(result?.matchedBy).toBe("head-sha");
		expect(result?.caught).toEqual(["src/old.test.ts"]);
	});

	it("returns null when no prediction exists for the requested commit", async () => {
		const dir = createTempWorkspace("verify");
		await appendImpactPrediction(defaultHistoryDir(dir), prediction({}));
		const report = writeReport(dir, "report.json", []);

		expect(
			await verifyImpact(dir, report, { headSha: "f".repeat(40) }),
		).toBeNull();
	});

	it("appends one reconciliation per verified run", async () => {
		const dir = createTempWorkspace("verify");
		await appendImpactPrediction(defaultHistoryDir(dir), prediction({}));
		const report = writeReport(dir, "report.json", ["src/format.test.ts"]);

		await verifyImpact(dir, report);
		await verifyImpact(dir, report);

		const records = await readReconciliations(defaultHistoryDir(dir));
		expect(records).toHaveLength(2);
		expect(records[0]?.falseSkips).toBe(1);
		expect(records[0]?.headSha).toBe("a".repeat(40));
	});

	it("does not write a reconciliation when logging is off", async () => {
		const dir = createTempWorkspace("verify");
		await appendImpactPrediction(defaultHistoryDir(dir), prediction({}));
		const report = writeReport(dir, "report.json", []);

		await verifyImpact(dir, report, { log: false });

		expect(await readReconciliations(defaultHistoryDir(dir))).toEqual([]);
	});

	it("rejects a report the runner did not produce", async () => {
		const dir = createTempWorkspace("verify");
		await appendImpactPrediction(defaultHistoryDir(dir), prediction({}));
		writeFiles(dir, { "junk.json": "not json at all" });

		await expect(verifyImpact(dir, "junk.json")).rejects.toBeInstanceOf(
			ImpactReportError,
		);
	});

	// A mistyped path is a usage mistake, not a bug in variant: it once
	// escaped as a raw ENOENT and printed "please file a bug" with exit 2.
	it("rejects a report path that does not exist", async () => {
		const dir = createTempWorkspace("verify");
		await appendImpactPrediction(defaultHistoryDir(dir), prediction({}));

		await expect(verifyImpact(dir, "missing.json")).rejects.toMatchObject({
			code: "IMPACT_REPORT_ERROR",
			message: expect.stringContaining("missing.json"),
		});
	});
});
