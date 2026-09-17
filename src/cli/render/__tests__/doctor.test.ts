import { beforeEach, describe, expect, it } from "vitest";
import { captureOutput } from "../../../__tests__/helpers/cli-harness.js";
import { writeGlobalColorChoice } from "../../visuals/color.js";
import { renderDiagnostics } from "../doctor.js";

beforeEach(() => {
	writeGlobalColorChoice("never");
});

describe("renderDiagnostics", () => {
	it("marks each level with its own icon", () => {
		const capture = captureOutput();

		renderDiagnostics(
			[
				{ level: "ok", label: "all good" },
				{ level: "warn", label: "worth a look" },
				{ level: "error", label: "broken" },
			],
			capture.printer,
		);

		expect(capture.stdout()).toContain("[✓] all good");
		expect(capture.stdout()).toContain("[!] worth a look");
		expect(capture.stdout()).toContain("[✗] broken");
	});

	it("indents the actionable detail under its diagnostic", () => {
		const capture = captureOutput();

		renderDiagnostics(
			[{ level: "error", label: "broken", detail: "Run `variant init`." }],
			capture.printer,
		);

		expect(capture.stdout()).toContain("      → Run `variant init`.");
	});

	it("omits the detail line when there is nothing to add", () => {
		const capture = captureOutput();

		renderDiagnostics([{ level: "ok", label: "all good" }], capture.printer);

		expect(capture.stdout()).not.toContain("→");
	});

	it("writes nothing for an empty report", () => {
		const capture = captureOutput();

		renderDiagnostics([], capture.printer);

		expect(capture.stdout()).toBe("");
	});
});
