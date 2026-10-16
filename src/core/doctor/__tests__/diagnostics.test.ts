import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../diagnostics.js";
import {
	checkNodeVersion,
	hasFailure,
	MINIMUM_NODE_MAJOR,
} from "../diagnostics.js";

describe("checkNodeVersion", () => {
	it("passes on the minimum supported major", () => {
		const result = checkNodeVersion(`v${MINIMUM_NODE_MAJOR}.0.0`);

		expect(result.level).toBe("ok");
		expect(result.detail).toBeUndefined();
	});

	it("passes on a major above the minimum", () => {
		expect(checkNodeVersion(`v${MINIMUM_NODE_MAJOR + 4}.1.2`).level).toBe("ok");
	});

	it("fails on a major below the minimum and says how to fix it", () => {
		const result = checkNodeVersion(`v${MINIMUM_NODE_MAJOR - 2}.0.0`);

		expect(result.level).toBe("error");
		expect(result.detail).toMatch(/Upgrade Node/);
	});

	it("fails closed on an unparseable version string", () => {
		expect(checkNodeVersion("not-a-version").level).toBe("error");
	});

	it("requires the Node version package.json declares", () => {
		const manifest = JSON.parse(
			readFileSync(
				new URL("../../../../package.json", import.meta.url),
				"utf8",
			),
		) as { engines: { node: string } };

		expect(manifest.engines.node).toBe(`>=${MINIMUM_NODE_MAJOR}`);
	});
});

describe("hasFailure", () => {
	const at = (level: Diagnostic["level"]): Diagnostic => ({
		level,
		label: level,
	});

	it("is false when everything passed", () => {
		expect(hasFailure([at("ok"), at("ok")])).toBe(false);
	});

	it("is false for warnings, which are informational", () => {
		expect(hasFailure([at("ok"), at("warn")])).toBe(false);
	});

	it("is true when any diagnostic is an error", () => {
		expect(hasFailure([at("ok"), at("warn"), at("error")])).toBe(true);
	});

	it("is false for an empty report", () => {
		expect(hasFailure([])).toBe(false);
	});
});
