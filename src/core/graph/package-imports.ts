/**
 * @module
 * `package.json` `imports`: the `#name` specifiers a package maps to files of
 * its own (Node subpath imports). They are flattened into the same alias
 * table as tsconfig `paths`, scoped to the package's directory, so one
 * resolver follows both.
 *
 * Unread, such a specifier looked like a third-party package: no edge to the
 * file it names, and a change there reached none of its importers.
 */

import path from "node:path";
import { conditionTargets } from "./package-exports.js";
import type { PathAlias } from "./tsconfig-paths.js";

/**
 * Aliases for the `imports` field of the manifest in `dir` (workspace-relative
 * POSIX, "" for the root). Every condition's target is offered, since any of
 * them may be the source. A target that names another package instead of a
 * file is left out: it is a dependency, not an edge inside the workspace.
 */
export function toImportAliases(
	dir: string,
	importsField: unknown,
): PathAlias[] {
	if (
		typeof importsField !== "object" ||
		importsField === null ||
		Array.isArray(importsField)
	) {
		return [];
	}

	const aliases: PathAlias[] = [];
	for (const [key, value] of Object.entries(importsField)) {
		if (!key.startsWith("#")) continue;
		// Node allows one `*` in a key; more than one is not a pattern it honors.
		const stars = key.split("*").length - 1;
		if (stars > 1) continue;

		const targets = conditionTargets(value)
			.filter((target) => target.startsWith("./"))
			.map((target) => path.posix.join(dir, target));
		if (targets.length === 0) continue;

		const wildcard = stars === 1;
		const [prefix = "", suffix = ""] = wildcard ? key.split("*") : [key, ""];
		aliases.push({
			prefix,
			suffix,
			wildcard,
			targets,
			...(dir !== "" && { scope: dir }),
		});
	}

	// Longest prefix first, as Node prefers the most specific pattern.
	aliases.sort((a, b) => b.prefix.length - a.prefix.length);
	return aliases;
}
