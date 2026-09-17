/**
 * @module
 * Turns a set of interesting packages into the predicates the runner accepts.
 * Workspace tasks are named `<package>:<script>`; a task without a colon is a
 * root-level task that belongs to no package.
 */

/** The package a task belongs to, or null for a root-level task. */
export function taskPackage(taskName: string): string | null {
	const colon = taskName.indexOf(":");
	return colon === -1 ? null : taskName.slice(0, colon);
}

/**
 * Runs only tasks belonging to `packages`. Root-level tasks always run — they
 * are not attributable to a package, so excluding them would silently drop
 * work the user asked for.
 */
export function affectedTaskFilter(
	packages: ReadonlySet<string>,
): (taskName: string) => boolean {
	return (taskName) => {
		const pkg = taskPackage(taskName);
		return pkg === null || packages.has(pkg);
	};
}

/** Composes two predicates; either may be absent. */
export function bothFilters(
	first: ((taskName: string) => boolean) | undefined,
	second: (taskName: string) => boolean,
): (taskName: string) => boolean {
	if (first === undefined) return second;
	return (taskName) => first(taskName) && second(taskName);
}
