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

/** How this repository runs one script of one package. */
export function commandFor(
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

/**
 * A root script that hands the work to every package: a task runner, or a
 * package manager told to recurse.
 */
const FANS_OUT =
	/\b(?:turbo|nx|lerna)\b|\s(?:-r|--recursive|--filter|--workspaces|-ws)\b|\bworkspaces\s+foreach\b/;

export function planChecks(
	packages: readonly PackageScripts[],
	style: CommandStyle,
	options: {
		/**
		 * True when `packages` is the whole workspace. A root script that
		 * already runs every package's then stands for all of them.
		 */
		everyPackage?: boolean;
	} = {},
): PlannedCheck[] {
	const covered = new Set<CheckKind>();
	const checks: PlannedCheck[] = [];
	for (const pkg of packages) {
		for (const script of Object.keys(pkg.scripts).sort()) {
			const kind = KINDS.find(([, pattern]) => pattern.test(script))?.[0];
			if (kind === undefined) continue;
			if (
				options.everyPackage === true &&
				pkg.dir === "" &&
				FANS_OUT.test(` ${pkg.scripts[script] ?? ""}`)
			) {
				covered.add(kind);
			}
			checks.push({
				kind,
				package: pkg.name ?? pkg.dir,
				dir: pkg.dir,
				script,
				command: commandFor(pkg, script, style),
			});
		}
	}
	return checks
		.filter((check) => check.dir === "" || !covered.has(check.kind))
		.sort(
			(a, b) =>
				ORDER[a.kind] - ORDER[b.kind] ||
				a.dir.localeCompare(b.dir) ||
				a.script.localeCompare(b.script),
		);
}
