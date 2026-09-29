import { describe, expect, it } from "vitest";
import { deriveVerdict, resolutionOf, verdictText } from "../verdict.js";

describe("deriveVerdict", () => {
	it("reports safe-to-skip when nothing changed", () => {
		expect(deriveVerdict([])).toBe("safe-to-skip");
	});

	it("reports safe-to-skip when every change is non-impacting", () => {
		expect(deriveVerdict(["non-impacting", "non-impacting"])).toBe(
			"safe-to-skip",
		);
	});

	it("recommends a build for a body-only change", () => {
		expect(deriveVerdict(["non-impacting", "internal"])).toBe(
			"build-recommended",
		);
	});

	it("recommends a build for a file the analysis could not read", () => {
		expect(deriveVerdict(["unanalyzed"])).toBe("build-recommended");
	});

	it("requires a build when any change is breaking", () => {
		expect(deriveVerdict(["internal", "breaking", "non-impacting"])).toBe(
			"build-required",
		);
	});

	it("lets breaking win regardless of position in the list", () => {
		expect(deriveVerdict(["breaking", "internal"])).toBe("build-required");
		expect(deriveVerdict(["internal", "breaking"])).toBe("build-required");
	});

	it("escalates to build-required when forceBuild is set", () => {
		expect(deriveVerdict(["non-impacting"], { forceBuild: true })).toBe(
			"build-required",
		);
	});

	it("ignores forceBuild when it is explicitly false", () => {
		expect(deriveVerdict(["non-impacting"], { forceBuild: false })).toBe(
			"safe-to-skip",
		);
	});
});

describe("verdictText", () => {
	it("gives every verdict a human-readable form", () => {
		expect(verdictText("safe-to-skip")).toBe("safe to skip build");
		expect(verdictText("build-recommended")).toBe("build recommended");
		expect(verdictText("build-required")).toBe("build required");
	});
});

describe("resolutionOf", () => {
	it.each([
		[1, "high"],
		[0.9, "high"],
		[0.8, "medium"],
		[0.7, "medium"],
		[0.6, "low"],
		[0.3, "low"],
	])("buckets a confidence of %f as %s", (confidence, bucket) => {
		expect(resolutionOf(confidence)).toBe(bucket);
	});
});
