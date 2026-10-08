/**
 * @module
 * Which commit a change is measured against, and which commit the result is
 * recorded as, when nobody says.
 *
 * A flag for each was the difference between a workflow that could be copied
 * and one that had to be adapted: the base is `origin/<target>` in a pull
 * request and the replaced commit on a push, and the commit checked out in a
 * pull request is a merge GitHub makes for the run, which nobody can look up
 * afterwards. All of that is in the environment already.
 */

import { readFile } from "node:fs/promises";
import { GitRefError, NoBaseCommitError } from "../errors.js";
import { defaultBranchRef, mergeBase, resolveCommit } from "./git.js";

export type BaseSource =
	/** `--base`. */
	| "flag"
	/** `VARIANT_BASE`, for a CI system this module cannot read. */
	| "environment"
	| "pull-request"
	| "push"
	| "default-branch"
	| "previous-commit";

export interface ChangeBase {
	/** The ref or commit to diff against. */
	ref: string;
	source: BaseSource;
	/** What `ref` stands for, in words. */
	label: string;
	/**
	 * The commit to record the result against, where the environment names a
	 * better one than HEAD: in a pull request, the commit that was pushed.
	 */
	headSha?: string;
}

/** Everything the decision reads, so it can be tested without git or CI. */
export interface ChangeBaseDeps {
	env: Readonly<Record<string, string | undefined>>;
	/** The parsed event payload, or undefined when it cannot be read. */
	readEvent: (path: string) => Promise<unknown>;
	resolveCommit: (ref: string) => Promise<string | null>;
	mergeBase: (a: string, b: string) => Promise<string | null>;
	defaultBranch: () => Promise<string | null>;
}

export function changeBaseDeps(cwd: string): ChangeBaseDeps {
	return {
		env: process.env,
		readEvent: async (path) => {
			try {
				return JSON.parse(await readFile(path, "utf8")) as unknown;
			} catch {
				return undefined;
			}
		},
		resolveCommit: (ref) => resolveCommit(cwd, ref),
		mergeBase: (a, b) => mergeBase(cwd, a, b),
		defaultBranch: () => defaultBranchRef(cwd),
	};
}

const ZERO_SHA = /^0+$/;

function field(value: unknown, ...keys: string[]): unknown {
	let current = value;
	for (const key of keys) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function isPullRequest(env: ChangeBaseDeps["env"]): boolean {
	const event = env["GITHUB_EVENT_NAME"];
	return (
		env["GITHUB_ACTIONS"] === "true" &&
		(event === "pull_request" || event === "pull_request_target") &&
		(env["GITHUB_BASE_REF"] ?? "") !== ""
	);
}

async function readEvent(deps: ChangeBaseDeps): Promise<unknown> {
	const path = deps.env["GITHUB_EVENT_PATH"];
	return path === undefined || path === "" ? undefined : deps.readEvent(path);
}

/**
 * The base for comparing against the working tree (`impact`).
 *
 * A pull request and a local branch are both measured from their merge base
 * with the branch they will land on: what the branch changed, whichever of
 * its commits is checked out. A ref the caller names is used as given.
 */
export async function resolveChangeBase(
	explicit: string | undefined,
	deps: ChangeBaseDeps,
): Promise<ChangeBase> {
	if (explicit !== undefined) {
		return { ref: explicit, source: "flag", label: explicit };
	}
	const fromEnvironment = deps.env["VARIANT_BASE"];
	if (fromEnvironment !== undefined && fromEnvironment !== "") {
		return {
			ref: fromEnvironment,
			source: "environment",
			label: `${fromEnvironment} (VARIANT_BASE)`,
		};
	}

	if (isPullRequest(deps.env)) {
		const target = `origin/${deps.env["GITHUB_BASE_REF"]}`;
		if ((await deps.resolveCommit(target)) === null) {
			throw new GitRefError(
				`The pull request's target branch, "${target}", is not in this clone`,
			);
		}
		const fork = await deps.mergeBase("HEAD", target);
		if (fork === null) {
			throw new GitRefError(
				`"${target}" shares no history with HEAD in this clone`,
			);
		}
		const pushed = field(await readEvent(deps), "pull_request", "head", "sha");
		return {
			ref: fork,
			source: "pull-request",
			label: `merge base with ${target}`,
			...(typeof pushed === "string" && pushed !== "" && { headSha: pushed }),
		};
	}

	if (
		deps.env["GITHUB_ACTIONS"] === "true" &&
		deps.env["GITHUB_EVENT_NAME"] === "push"
	) {
		const before = field(await readEvent(deps), "before");
		if (
			typeof before !== "string" ||
			before === "" ||
			ZERO_SHA.test(before) ||
			(await deps.resolveCommit(before)) === null
		) {
			throw new NoBaseCommitError();
		}
		const pushed = deps.env["GITHUB_SHA"];
		return {
			ref: before,
			source: "push",
			label: "the commit this push replaced",
			...(pushed !== undefined && pushed !== "" && { headSha: pushed }),
		};
	}

	const branch = await deps.defaultBranch();
	if (branch !== null) {
		const [fork, head] = await Promise.all([
			deps.mergeBase("HEAD", branch),
			deps.resolveCommit("HEAD"),
		]);
		// On the default branch itself the merge base is HEAD, and comparing a
		// commit with itself would report every committed change as nothing.
		if (fork !== null && fork !== head) {
			return {
				ref: fork,
				source: "default-branch",
				label: `merge base with ${branch}`,
			};
		}
	}
	return { ref: "HEAD~1", source: "previous-commit", label: "previous commit" };
}

/**
 * The branch a pull request lands on (`pr check`, `pr report`), which diff
 * from their merge base with it themselves. `main` is the last resort so that
 * the error, when there is none, names something familiar.
 */
export async function resolvePullRequestBase(
	explicit: string | undefined,
	deps: ChangeBaseDeps,
): Promise<string> {
	if (explicit !== undefined) return explicit;
	if (isPullRequest(deps.env)) return `origin/${deps.env["GITHUB_BASE_REF"]}`;
	return (await deps.defaultBranch()) ?? "main";
}

/**
 * The commit a pull request or push is about, for finding the prediction made
 * for it. Undefined outside an environment that names one.
 */
export async function detectHeadSha(
	deps: ChangeBaseDeps,
): Promise<string | undefined> {
	if (deps.env["GITHUB_ACTIONS"] !== "true") return undefined;
	if (isPullRequest(deps.env)) {
		const pushed = field(await readEvent(deps), "pull_request", "head", "sha");
		return typeof pushed === "string" && pushed !== "" ? pushed : undefined;
	}
	const sha = deps.env["GITHUB_SHA"];
	return deps.env["GITHUB_EVENT_NAME"] === "push" &&
		sha !== undefined &&
		sha !== ""
		? sha
		: undefined;
}
