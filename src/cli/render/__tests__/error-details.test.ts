import { describe, expect, it } from "vitest";
import {
	BaselineFailedError,
	CheckBackendError,
} from "../../../core/errors.js";
import { writeGlobalColorChoice } from "../../visuals/color.js";
import { renderError } from "../error.js";

function rendered(error: Parameters<typeof renderError>[0]): string {
	writeGlobalColorChoice("never");
	let out = "";
	renderError(error, (text) => {
		out += text;
	});
	return out;
}

describe("renderError details", () => {
	it("names the tests that fail before any mutation", () => {
		const out = rendered(
			new BaselineFailedError(
				[{ name: "discount rejects 50", message: "expected false to be true" }],
				"",
				"vitest",
			),
		);

		expect(out).toContain("  discount rejects 50: expected false to be true");
	});

	// The hint used to say the engine's output was shown above when it was not.
	it("shows the engine's last output when it stopped on an error", () => {
		const out = rendered(
			new CheckBackendError(
				"No tests were executed",
				"line 1\n\nline 2\nline 3",
				"vitest",
			),
		);

		expect(out).toContain("  line 2\n  line 3\n");
		expect(out.indexOf("line 3")).toBeLessThan(out.indexOf("Hint:"));
	});

	it("does not point at output it does not have", () => {
		expect(rendered(new CheckBackendError("boom", "", "vitest"))).not.toMatch(
			/shown above/,
		);
	});
});
