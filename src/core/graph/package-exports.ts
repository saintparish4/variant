/**
 * @module
 * Subpath resolution through a workspace package's `exports` map.
 *
 * The map names *published* entry points, which in most monorepos are build
 * output (`./dist/index.js`) rather than the sources the symbol graph indexes.
 * So this does two things, in order: take the `exports` target when it names an
 * indexed file, and otherwise map that target back to the source it was built
 * from. Both are additive — a specifier this cannot place falls through to the
 * conventional `src/index.*` guesses that were there before, so adding
 * `exports` awareness can only find edges, never lose them.
 *
 * That direction matters: a missed edge is a missed dependent, which is a
 * missed test, which is a false skip.
 */

import path from "node:path";

/** Build directories whose contents are mapped back to a source tree. */
const BUILD_DIRS = ["dist", "lib", "build", "out", "es", "esm", "cjs"];

/**
 * Source roots a build output could have come from, most conventional first.
 * `lib` appears here and in BUILD_DIRS because both conventions are common —
 * it is stripped when it leads a target, and probed when looking for the
 * source that target was built from.
 */
const SOURCE_DIRS = ["src", "lib", "source", ""];

/**
 * Conditions worth following, most source-like first. `types` is deliberately
 * included — a `.d.ts` target still names the right *stem*, which is what the
 * source remap needs.
 */
const CONDITIONS = [
	"source",
	"development",
	"import",
	"module",
	"require",
	"types",
	"node",
	"default",
];

const MAX_CONDITION_DEPTH = 8;

/**
 * Flatten a conditional exports or imports value to the target strings worth
 * trying, in preference order. Arrays (fallback lists) contribute every entry.
 */
export function conditionTargets(value: unknown): string[] {
	return targetsOf(value);
}

function targetsOf(value: unknown, depth = 0): string[] {
	if (depth > MAX_CONDITION_DEPTH) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) {
		return value.flatMap((entry) => targetsOf(entry, depth + 1));
	}
	if (typeof value !== "object" || value === null) return [];

	const record = value as Record<string, unknown>;
	const out: string[] = [];
	for (const condition of CONDITIONS) {
		if (condition in record) {
			out.push(...targetsOf(record[condition], depth + 1));
		}
	}
	// A condition this does not know about is still better than nothing.
	for (const [key, nested] of Object.entries(record)) {
		if (!CONDITIONS.includes(key) && !key.startsWith(".")) {
			out.push(...targetsOf(nested, depth + 1));
		}
	}
	return out;
}

/** Strip the leading `./` an exports target conventionally carries. */
function clean(target: string): string | undefined {
	if (!target.startsWith("./")) return undefined;
	return target.slice(2);
}

/**
 * Package-relative candidate paths for `subpath` ("" for the package root),
 * in preference order. Returns [] when `exports` does not cover the subpath.
 */
export function resolveExportsSubpath(
	exportsField: unknown,
	subpath: string,
): string[] {
	if (exportsField === undefined || exportsField === null) return [];

	const request = subpath === "" ? "." : `./${subpath}`;

	// Sugar: `"exports": "./index.js"` or a bare condition object with no
	// subpath keys both mean the package root.
	const isSubpathMap =
		typeof exportsField === "object" &&
		!Array.isArray(exportsField) &&
		Object.keys(exportsField as Record<string, unknown>).some((k) =>
			k.startsWith("."),
		);
	if (!isSubpathMap) {
		return request === "."
			? targetsOf(exportsField)
					.map(clean)
					.filter((t): t is string => t !== undefined)
			: [];
	}

	const map = exportsField as Record<string, unknown>;

	if (request in map) {
		return targetsOf(map[request])
			.map(clean)
			.filter((t): t is string => t !== undefined);
	}

	// Wildcard subpaths (`"./*": "./dist/*.js"`), longest prefix first so the
	// most specific pattern wins, as Node resolves them.
	const patterns = Object.keys(map)
		.filter((key) => key.startsWith("./") && key.includes("*"))
		.sort((a, b) => b.length - a.length);

	for (const pattern of patterns) {
		const [prefix = "", suffix = ""] = pattern.split("*");
		if (
			request.length < prefix.length + suffix.length ||
			!request.startsWith(prefix) ||
			!request.endsWith(suffix)
		) {
			continue;
		}
		const captured = request.slice(
			prefix.length,
			request.length - suffix.length,
		);
		const targets = targetsOf(map[pattern])
			.map((t) => clean(t.replace("*", captured)))
			.filter((t): t is string => t !== undefined);
		if (targets.length > 0) return targets;
	}

	return [];
}

/**
 * Source paths a build-output target could have been built from:
 * `dist/utils/date.js` -> `src/utils/date`, `utils/date`.
 *
 * Extensions are dropped rather than remapped — the caller probes TS
 * extensions anyway, and a `.d.ts` target must lose both suffixes.
 */
export function toSourceCandidates(target: string): string[] {
	const withoutExtension = stripExtension(target);
	const segments = withoutExtension.split("/");
	const head = segments[0];

	const bodies =
		head !== undefined && BUILD_DIRS.includes(head) && segments.length > 1
			? [segments.slice(1).join("/")]
			: [withoutExtension];

	const out: string[] = [];
	for (const body of bodies) {
		for (const dir of SOURCE_DIRS) {
			out.push(dir === "" ? body : `${dir}/${body}`);
		}
	}
	return [...new Set(out)];
}

function stripExtension(target: string): string {
	if (target.endsWith(".d.ts")) return target.slice(0, -".d.ts".length);
	const ext = path.posix.extname(target);
	return ext === "" ? target : target.slice(0, -ext.length);
}

/**
 * Package-relative bases to probe for a bare import of a workspace package,
 * derived from its `exports` map. Ordered: the target as written first (it may
 * already name a source file), then what it was likely built from.
 */
export function exportsCandidates(
	exportsField: unknown,
	subpath: string,
): string[] {
	const targets = resolveExportsSubpath(exportsField, subpath);
	if (targets.length === 0) return [];

	const out: string[] = [];
	for (const target of targets) out.push(stripExtension(target));
	for (const target of targets) out.push(...toSourceCandidates(target));
	return [...new Set(out)];
}
