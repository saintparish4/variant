/**
 * @module
 * The package-level checks a change calls for: the typecheck, build, lint and
 * end-to-end scripts of each package it affects, as commands a person could
 * run. Planning only. variant runs none of them.
 */

import type { PackageManagerName } from "../setup/discover.js";

export type CheckKind = "typecheck" | "build" | "lint" | "e2e";

export interface PlannedCheck {
	kind: CheckKind;
	/** The package's name, or its directory when it has none. */
	package: string;
	/** Workspace-relative POSIX directory; "" for the root. */
	dir: string;
	script: string;
	command: string;
}

export interface PackageScripts {
	name: string | undefined;
	dir: string;
	scripts: Readonly<Record<string, string>>;
}

export interface CommandStyle {
	packageManager: PackageManagerName | null;
	taskRunner: "turborepo" | "nx" | null;
}

/**
 * Recognized by name, because a script's name is the only thing every
 * repository agrees on. Unit tests are left out: the plan lists test files
 * themselves. End-to-end suites stay, since no import leads to them.
 */
const KINDS: ReadonlyArray<[CheckKind, RegExp]> = [
	["typecheck", /^(?:type-?check|check-?types|tsc|types)$/],
	["build", /^build$/],
	["lint", /^lint$/],
	["e2e", /^(?:e2e|test[:-]e2e|e2e[:-]test)$/],
];

const ORDER: Record<CheckKind, number> = {
	typecheck: 0,
	build: 1,
	lint: 2,
	e2e: 3,
};

function commandFor(
	pkg: PackageScripts,
	script: string,
	style: CommandStyle,
): string {
	const manager = style.packageManager ?? "npm";
	if (pkg.dir === "" || pkg.name === undefined) {
		const prefix = pkg.dir === "" ? "" : `cd ${pkg.dir} && `;
		return `${prefix}${manager} run ${script}`;
	}
	if (style.taskRunner === "turborepo") {
		return `turbo run ${script} --filter=${pkg.name}`;
	}
	if (style.taskRunner === "nx") return `nx run ${pkg.name}:${script}`;
	if (manager === "pnpm") return `pnpm --filter ${pkg.name} run ${script}`;
	if (manager === "yarn") return `yarn workspace ${pkg.name} run ${script}`;
	if (manager === "bun") return `bun run --filter ${pkg.name} ${script}`;
	return `npm run ${script} --workspace ${pkg.name}`;
}

export function planChecks(
	packages: readonly PackageScripts[],
	style: CommandStyle,
): PlannedCheck[] {
	const checks: PlannedCheck[] = [];
	for (const pkg of packages) {
		for (const script of Object.keys(pkg.scripts).sort()) {
			const kind = KINDS.find(([, pattern]) => pattern.test(script))?.[0];
			if (kind === undefined) continue;
			checks.push({
				kind,
				package: pkg.name ?? pkg.dir,
				dir: pkg.dir,
				script,
				command: commandFor(pkg, script, style),
			});
		}
	}
	return checks.sort(
		(a, b) =>
			ORDER[a.kind] - ORDER[b.kind] ||
			a.dir.localeCompare(b.dir) ||
			a.script.localeCompare(b.script),
	);
}
