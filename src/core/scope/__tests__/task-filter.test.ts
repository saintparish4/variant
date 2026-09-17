import { describe, expect, it } from "vitest";
import {
	affectedTaskFilter,
	bothFilters,
	taskPackage,
} from "../task-filter.js";

describe("taskPackage", () => {
	it("extracts the package from a workspace task name", () => {
		expect(taskPackage("web:build")).toBe("web");
	});

	it("returns null for a root-level task", () => {
		expect(taskPackage("build")).toBeNull();
	});

	it("splits on the first colon so scripts may contain colons", () => {
		expect(taskPackage("web:test:watch")).toBe("web");
	});
});

describe("affectedTaskFilter", () => {
	it("keeps tasks belonging to an affected package", () => {
		expect(affectedTaskFilter(new Set(["web"]))("web:build")).toBe(true);
	});

	it("drops tasks belonging to an unaffected package", () => {
		expect(affectedTaskFilter(new Set(["web"]))("docs:build")).toBe(false);
	});

	it("always keeps root-level tasks, which belong to no package", () => {
		expect(affectedTaskFilter(new Set(["web"]))("build")).toBe(true);
	});

	it("drops everything package-scoped when nothing is affected", () => {
		expect(affectedTaskFilter(new Set())("web:build")).toBe(false);
	});
});

describe("bothFilters", () => {
	const isBuild = (task: string): boolean => task.endsWith(":build");
	const isWeb = (task: string): boolean => task.startsWith("web:");

	it("requires both predicates to pass", () => {
		const combined = bothFilters(isBuild, isWeb);
		expect(combined("web:build")).toBe(true);
		expect(combined("web:test")).toBe(false);
		expect(combined("docs:build")).toBe(false);
	});

	it("falls back to the second predicate when the first is absent", () => {
		const combined = bothFilters(undefined, isWeb);
		expect(combined("web:build")).toBe(true);
		expect(combined("docs:build")).toBe(false);
	});
});
