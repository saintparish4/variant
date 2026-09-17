import { describe, expect, it } from "vitest";
import type { TaskConfig, TaskProvenance } from "../../../types/index.js";
import { buildGraph } from "../../graph/planner.js";
import { buildProvenance, packageOfTask, recordCacheMiss } from "../capture.js";

function build(
	tasks: Record<string, TaskConfig>,
	extra: Partial<Parameters<typeof buildProvenance>[0]> = {},
) {
	return buildProvenance({
		tasks,
		graph: buildGraph({
			strategy: "adaptive",
			cache: { mode: "content", directory: ".variant/cache" },
			tasks,
		}),
		strategy: "adaptive",
		...extra,
	});
}

const cacheable: TaskConfig = { inputs: ["src/**/*.ts"] };

describe("packageOfTask", () => {
	it("test_splits_workspace_task_into_package", () => {
		expect(packageOfTask("web:build")).toBe("web");
	});

	it("test_scoped_package_name_survives_split", () => {
		// The scope's slash must not be mistaken for a separator, and the
		// package half itself contains no colon to split on.
		expect(packageOfTask("@acme/web:build")).toBe("@acme/web");
	});

	it("test_plain_task_belongs_to_no_package", () => {
		expect(packageOfTask("typecheck")).toBeUndefined();
	});
});

describe("run reason selection", () => {
	it("test_reason_always_for_task_without_inputs", () => {
		const provenance = build({ build: { command: "echo hi" } });
		expect(provenance.get("build")?.reason).toEqual({ kind: "always" });
	});

	it("test_reason_always_under_strict_strategy", () => {
		// Strict skips the hash comparison entirely, so even a task with
		// inputs can only ever be "always".
		const provenance = build({ build: cacheable }, { strategy: "strict" });
		expect(provenance.get("build")?.reason).toEqual({ kind: "always" });
	});

	it("test_reason_affected_by_carries_changed_files", () => {
		const provenance = build(
			{ build: cacheable },
			{ changedFiles: ["packages/api/src/db.ts"] },
		);
		expect(provenance.get("build")?.reason).toEqual({
			kind: "affected-by",
			changedFiles: ["packages/api/src/db.ts"],
		});
	});

	it("test_changed_files_are_copied_not_aliased", () => {
		const changedFiles = ["a.ts"];
		const provenance = build({ build: cacheable }, { changedFiles });
		changedFiles.push("b.ts");
		const reason = provenance.get("build")?.reason;
		expect(reason).toEqual({ kind: "affected-by", changedFiles: ["a.ts"] });
	});

	it("test_reason_upgraded_to_cache_miss_with_both_hashes", () => {
		const provenance = build({ build: cacheable });
		recordCacheMiss(provenance, "build", "oldhash", "newhash");
		expect(provenance.get("build")?.reason).toEqual({
			kind: "cache-miss",
			expectedHash: "oldhash",
			actualHash: "newhash",
		});
	});

	it("test_first_run_reports_null_expected_hash", () => {
		// Never cached is a different story from invalidated, and the reader
		// should be able to tell them apart.
		const provenance = build({ build: cacheable });
		recordCacheMiss(provenance, "build", null, "newhash");
		expect(provenance.get("build")?.reason).toEqual({
			kind: "cache-miss",
			expectedHash: null,
			actualHash: "newhash",
		});
	});

	it("test_cache_miss_for_unknown_task_is_a_noop", () => {
		const provenance = build({ build: cacheable });
		expect(() =>
			recordCacheMiss(provenance, "nonexistent", null, "h"),
		).not.toThrow();
		expect(provenance.has("nonexistent")).toBe(false);
	});

	it("test_cache_miss_tolerates_absent_provenance_map", () => {
		// The runner's provenance option is optional; unit tests that construct
		// RunOptions by hand must not be forced to supply one.
		expect(() => recordCacheMiss(undefined, "build", null, "h")).not.toThrow();
	});
});

describe("dag adjacency", () => {
	const tasks = {
		"utils:build": cacheable,
		"web:build": { ...cacheable, dependsOn: ["utils:build"] },
		"docs:build": { ...cacheable, dependsOn: ["utils:build"] },
		"api:build": { ...cacheable, dependsOn: ["web:build"] },
	};

	it("test_upstream_tasks_are_direct_dependencies", () => {
		expect(build(tasks).get("web:build")?.upstreamTasks).toEqual([
			"utils:build",
		]);
	});

	it("test_task_without_dependencies_has_no_upstream", () => {
		expect(build(tasks).get("utils:build")?.upstreamTasks).toEqual([]);
	});

	it("test_dirty_dependents_are_reverse_edges", () => {
		expect(build(tasks).get("utils:build")?.dirtyDependents).toEqual([
			"docs:build",
			"web:build",
		]);
	});

	it("test_dependents_are_sorted_for_stable_output", () => {
		// Insertion order here is web, docs — output must not follow it, or a
		// reason block would reshuffle between otherwise identical runs.
		const provenance = build({
			"utils:build": cacheable,
			"web:build": { ...cacheable, dependsOn: ["utils:build"] },
			"docs:build": { ...cacheable, dependsOn: ["utils:build"] },
		});
		expect(provenance.get("utils:build")?.dirtyDependents).toEqual([
			"docs:build",
			"web:build",
		]);
	});

	it("test_dependents_narrowed_to_affected_packages", () => {
		// docs is unaffected by the diff, so naming it as also-invalidated
		// would be wrong — only web is.
		const provenance = build(tasks, {
			affectedPackages: new Set(["utils", "web", "api"]),
		});
		expect(provenance.get("utils:build")?.dirtyDependents).toEqual([
			"web:build",
		]);
	});

	it("test_all_dependents_dirty_without_diff_information", () => {
		// No git signal means no basis for narrowing; over-reporting a
		// dependent is cosmetic, hiding the relevant one is not.
		expect(build(tasks).get("utils:build")?.dirtyDependents).toEqual([
			"docs:build",
			"web:build",
		]);
	});

	it("test_every_task_gets_an_entry", () => {
		const provenance = build(tasks);
		expect([...provenance.keys()].sort()).toEqual([
			"api:build",
			"docs:build",
			"utils:build",
			"web:build",
		]);
	});

	it("test_entry_is_self_identifying", () => {
		const entry = build(tasks).get("web:build") as TaskProvenance;
		expect(entry.taskId).toBe("web:build");
	});
});
