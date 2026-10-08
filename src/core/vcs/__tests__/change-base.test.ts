import { describe, expect, it } from "vitest";
import type { ChangeBaseDeps } from "../change-base.js";
import { resolveChangeBase, resolvePullRequestBase } from "../change-base.js";

const HEAD = "h".repeat(40);
const FORK = "f".repeat(40);
const BEFORE = "b".repeat(40);
const PR_HEAD = "p".repeat(40);

/** A clone where every named ref exists unless a test says otherwise. */
function deps(overrides: Partial<ChangeBaseDeps> = {}): ChangeBaseDeps {
	return {
		env: {},
		readEvent: async () => undefined,
		resolveCommit: async (ref) => (ref === "HEAD" ? HEAD : `sha-of-${ref}`),
		mergeBase: async () => FORK,
		defaultBranch: async () => "origin/main",
		...overrides,
	};
}

const pullRequest = {
	GITHUB_ACTIONS: "true",
	GITHUB_EVENT_NAME: "pull_request",
	GITHUB_BASE_REF: "main",
	GITHUB_EVENT_PATH: "/event.json",
	GITHUB_SHA: "m".repeat(40),
};

const push = {
	GITHUB_ACTIONS: "true",
	GITHUB_EVENT_NAME: "push",
	GITHUB_EVENT_PATH: "/event.json",
	GITHUB_SHA: HEAD,
};

describe("resolveChangeBase", () => {
	it("takes a ref the caller named over anything it could detect", async () => {
		const base = await resolveChangeBase(
			"release/2",
			deps({ env: { ...pullRequest, VARIANT_BASE: "other" } }),
		);
		expect(base).toEqual({
			ref: "release/2",
			source: "flag",
			label: "release/2",
		});
	});

	it("takes VARIANT_BASE next, for CI systems it cannot read", async () => {
		const base = await resolveChangeBase(
			undefined,
			deps({ env: { VARIANT_BASE: "origin/develop" } }),
		);
		expect(base).toMatchObject({
			ref: "origin/develop",
			source: "environment",
		});
	});

	// A pull request is checked out as a merge commit GitHub makes for the
	// run. The merge base is the same whichever commit is checked out, and the
	// pushed commit is the one a person can look up afterwards.
	it("measures a pull request from its merge base with the target branch", async () => {
		const base = await resolveChangeBase(
			undefined,
			deps({
				env: pullRequest,
				readEvent: async () => ({ pull_request: { head: { sha: PR_HEAD } } }),
			}),
		);
		expect(base).toEqual({
			ref: FORK,
			source: "pull-request",
			label: "merge base with origin/main",
			headSha: PR_HEAD,
		});
	});

	it("says what to do when the pull request's target branch was not fetched", async () => {
		await expect(
			resolveChangeBase(
				undefined,
				deps({
					env: pullRequest,
					resolveCommit: async (ref) => (ref === "HEAD" ? HEAD : null),
				}),
			),
		).rejects.toMatchObject({
			code: "GIT_REF_ERROR",
			message: expect.stringContaining("origin/main"),
		});
	});

	it("says so when a shallow clone holds both tips and not the commit they share", async () => {
		await expect(
			resolveChangeBase(
				undefined,
				deps({ env: pullRequest, mergeBase: async () => null }),
			),
		).rejects.toMatchObject({ code: "GIT_REF_ERROR" });
	});

	it("measures a push from the commit it replaced", async () => {
		const base = await resolveChangeBase(
			undefined,
			deps({ env: push, readEvent: async () => ({ before: BEFORE }) }),
		);
		expect(base).toEqual({
			ref: BEFORE,
			source: "push",
			label: "the commit this push replaced",
			headSha: HEAD,
		});
	});

	// The first push of a branch names no previous commit, and a force-push can
	// name one that is gone. Neither is a mistake by the user.
	it.each([
		["a branch's first push", "0".repeat(40)],
		["a force-push whose old head is gone", BEFORE],
	])("has nothing to compare against on %s", async (_, before) => {
		await expect(
			resolveChangeBase(
				undefined,
				deps({
					env: push,
					readEvent: async () => ({ before }),
					resolveCommit: async (ref) => (ref === "HEAD" ? HEAD : null),
				}),
			),
		).rejects.toMatchObject({ code: "NO_BASE_COMMIT" });
	});

	it("falls back to the local rules on a GitHub event that names no base", async () => {
		const base = await resolveChangeBase(
			undefined,
			deps({ env: { ...push, GITHUB_EVENT_NAME: "workflow_dispatch" } }),
		);
		expect(base.source).toBe("default-branch");
	});

	it("measures a local branch from where it left the default branch", async () => {
		const base = await resolveChangeBase(undefined, deps());
		expect(base).toEqual({
			ref: FORK,
			source: "default-branch",
			label: "merge base with origin/main",
		});
	});

	it("measures the last commit when the checkout is the default branch itself", async () => {
		const base = await resolveChangeBase(
			undefined,
			deps({ mergeBase: async () => HEAD }),
		);
		expect(base).toEqual({
			ref: "HEAD~1",
			source: "previous-commit",
			label: "previous commit",
		});
	});

	it("measures the last commit when no default branch can be found", async () => {
		const base = await resolveChangeBase(
			undefined,
			deps({ defaultBranch: async () => null }),
		);
		expect(base.source).toBe("previous-commit");
	});
});

describe("resolvePullRequestBase", () => {
	it("is the target branch in a pull request", async () => {
		expect(
			await resolvePullRequestBase(undefined, deps({ env: pullRequest })),
		).toBe("origin/main");
	});

	it("is the default branch locally, whatever it is called", async () => {
		expect(
			await resolvePullRequestBase(
				undefined,
				deps({ defaultBranch: async () => "origin/master" }),
			),
		).toBe("origin/master");
	});

	it("keeps the ref the caller named", async () => {
		expect(await resolvePullRequestBase("develop", deps())).toBe("develop");
	});

	it("falls back to main, so the error names something familiar", async () => {
		expect(
			await resolvePullRequestBase(
				undefined,
				deps({ defaultBranch: async () => null }),
			),
		).toBe("main");
	});
});
