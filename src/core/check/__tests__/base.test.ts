import { describe, expect, it } from "vitest";
import { NoChangeBaseError } from "../../errors.js";
import type { CheckBaseDeps } from "../base.js";
import { resolveCheckBase } from "../base.js";

const HEAD = "h".repeat(40);
const FORK = "f".repeat(40);

function deps(overrides: Partial<CheckBaseDeps> = {}): CheckBaseDeps {
	return {
		env: {},
		readEvent: async () => undefined,
		resolveCommit: async (ref) => (ref === "HEAD" ? HEAD : `sha-of-${ref}`),
		mergeBase: async () => FORK,
		defaultBranch: async () => "origin/main",
		hasLocalChanges: async () => false,
		...overrides,
	};
}

describe("resolveCheckBase", () => {
	it("compares uncommitted changes with HEAD, on a branch too", async () => {
		const base = await resolveCheckBase(
			undefined,
			deps({ hasLocalChanges: async () => true }),
		);
		expect(base.ref).toBe("HEAD");
	});

	// A new file not yet added is a change too: on the default branch it would
	// otherwise read as nothing to compare.
	it("compares a tree whose only change is a new file with HEAD", async () => {
		const base = await resolveCheckBase(
			undefined,
			deps({
				mergeBase: async () => "h".repeat(40),
				hasLocalChanges: async () => true,
			}),
		);
		expect(base.ref).toBe("HEAD");
	});

	it("compares a clean branch with where it left the default branch", async () => {
		const base = await resolveCheckBase(undefined, deps());
		expect(base).toEqual({ ref: FORK, label: "merge base with origin/main" });
	});

	it("refuses to guess on a clean default branch, where HEAD~1 would be a guess", async () => {
		await expect(
			resolveCheckBase(undefined, deps({ mergeBase: async () => HEAD })),
		).rejects.toBeInstanceOf(NoChangeBaseError);
	});

	it("refuses to guess where there is no default branch at all", async () => {
		await expect(
			resolveCheckBase(undefined, deps({ defaultBranch: async () => null })),
		).rejects.toBeInstanceOf(NoChangeBaseError);
	});

	it("takes --base over uncommitted changes", async () => {
		const base = await resolveCheckBase(
			"origin/release",
			deps({ hasLocalChanges: async () => true }),
		);
		expect(base.ref).toBe("origin/release");
	});

	// A codegen step in CI can leave tracked files modified; the pull request
	// still names the base.
	it("takes the pull request's base over a tree a CI step dirtied", async () => {
		const base = await resolveCheckBase(
			undefined,
			deps({
				env: {
					GITHUB_ACTIONS: "true",
					GITHUB_EVENT_NAME: "pull_request",
					GITHUB_BASE_REF: "main",
				},
				hasLocalChanges: async () => true,
			}),
		);
		expect(base.ref).toBe(FORK);
	});

	it("takes the commit a push replaced", async () => {
		const before = "b".repeat(40);
		const base = await resolveCheckBase(
			undefined,
			deps({
				env: {
					GITHUB_ACTIONS: "true",
					GITHUB_EVENT_NAME: "push",
					GITHUB_EVENT_PATH: "/event.json",
				},
				readEvent: async () => ({ before }),
			}),
		);
		expect(base.ref).toBe(before);
	});
});
