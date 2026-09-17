import { describe, expect, it } from "vitest";
import type { TaskProvenance } from "../../../types/index.js";
import { ConfigError, TaskExecutionError, VariantError } from "../../errors.js";
import { attachProvenance } from "../attach.js";

function provenanceFor(taskId: string): TaskProvenance {
	return {
		taskId,
		reason: { kind: "cache-miss", expectedHash: "old", actualHash: "new" },
		dirtyDependents: ["web:build"],
		upstreamTasks: ["utils:build"],
	};
}

function mapOf(...entries: TaskProvenance[]): Map<string, TaskProvenance> {
	return new Map(entries.map((entry) => [entry.taskId, entry]));
}

describe("attachProvenance", () => {
	it("test_attaches_matching_entry_to_task_error", () => {
		const entry = provenanceFor("web:test");
		const failure = attachProvenance(
			new TaskExecutionError("web:test", 1),
			"web:test",
			mapOf(entry),
		);

		expect(failure.provenance).toEqual(entry);
	});

	it("test_preserves_the_original_error_identity", () => {
		// Wrapping a VariantError would bury its code and hint, which the CLI's
		// existing failure output already renders.
		const original = new TaskExecutionError("web:test", 3);
		const failure = attachProvenance(original, "web:test", mapOf());

		expect(failure).toBe(original);
		expect(failure.code).toBe("TASK_EXECUTION_ERROR");
	});

	it("test_wraps_a_non_variant_error_as_task_failure", () => {
		// An injected executor can throw anything; a failing task command is a
		// task failure, not an internal bug.
		const failure = attachProvenance(
			new Error("biome exited 1"),
			"web:lint",
			mapOf(),
		);

		expect(failure).toBeInstanceOf(TaskExecutionError);
		expect(failure).toBeInstanceOf(VariantError);
	});

	it("test_wrapped_error_keeps_the_original_as_cause", () => {
		const original = new Error("biome exited 1");
		const failure = attachProvenance(original, "web:lint", mapOf());

		expect(failure.cause).toBe(original);
	});

	it("test_wraps_a_non_error_throwable", () => {
		const failure = attachProvenance("just a string", "web:lint", mapOf());

		expect(failure).toBeInstanceOf(TaskExecutionError);
		expect(failure.message).toContain("just a string");
	});

	it("test_wrapped_error_still_receives_provenance", () => {
		const entry = provenanceFor("web:lint");
		const failure = attachProvenance(
			new Error("boom"),
			"web:lint",
			mapOf(entry),
		);

		expect(failure.provenance).toEqual(entry);
	});

	it("test_no_provenance_when_run_captured_none", () => {
		// A caller that never built a map (unit tests, library consumers) must
		// still get a throwable, just an unannotated one.
		const failure = attachProvenance(
			new TaskExecutionError("web:test", 1),
			"web:test",
			undefined,
		);

		expect(failure.provenance).toBeUndefined();
	});

	it("test_no_provenance_when_task_is_absent_from_map", () => {
		const failure = attachProvenance(
			new TaskExecutionError("web:test", 1),
			"web:test",
			mapOf(provenanceFor("docs:build")),
		);

		expect(failure.provenance).toBeUndefined();
	});

	it("test_attaches_only_the_failing_tasks_entry", () => {
		const failing = provenanceFor("web:test");
		const other = provenanceFor("docs:build");
		const failure = attachProvenance(
			new TaskExecutionError("web:test", 1),
			"web:test",
			mapOf(failing, other),
		);

		expect(failure.provenance?.taskId).toBe("web:test");
	});

	it("test_annotates_a_non_task_variant_error_it_is_handed", () => {
		// The runner only calls this around task execution, but the helper
		// should not silently drop provenance for an unexpected VariantError kind.
		const entry = provenanceFor("web:test");
		const failure = attachProvenance(
			new ConfigError("bad config"),
			"web:test",
			mapOf(entry),
		);

		expect(failure.code).toBe("CONFIG_ERROR");
		expect(failure.provenance).toEqual(entry);
	});
});
