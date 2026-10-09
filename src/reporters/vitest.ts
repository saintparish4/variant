/**
 * @module
 * The Vitest adapter. It translates Vitest's reporter hooks into a shadow run
 * and holds no logic of its own; see `shadow.ts`.
 *
 * ```ts
 * import variant from "@blzsky/variant/vitest";
 * export default defineConfig({ test: { reporters: ["default", variant()] } });
 * ```
 *
 * or, in a config that sets no reporters of its own:
 *
 * ```ts
 * import { variantReporters } from "@blzsky/variant/vitest";
 * export default defineConfig({ test: { reporters: variantReporters() } });
 * ```
 */

import type { Reporter, TestModule, Vitest } from "vitest/node";
import type { ShadowDeps, ShadowOptions, ShadowRun } from "./shadow.js";
import { shadowDeps, startShadow } from "./shadow.js";

export type VariantReporterOptions = ShadowOptions;

export function variantReporter(
	options: VariantReporterOptions = {},
	deps?: ShadowDeps,
): Reporter {
	let root = process.cwd();
	let watching = false;
	let log: ((line: string) => void) | undefined;
	let run: ShadowRun | undefined;

	return {
		onInit(vitest: Vitest) {
			root = vitest.config.root;
			watching = vitest.config.watch === true;
			// Through Vitest's own logger, so the line lands after its summary
			// and not in the middle of it.
			log = (line) => vitest.logger.log(line.replace(/\n$/, ""));
		},
		onTestRunStart() {
			// A watch session reruns a few files at a time; none of those is a
			// run worth reconciling.
			if (watching) return;
			const effects = deps ?? shadowDeps();
			run = startShadow(root, options, {
				...effects,
				...(log !== undefined && deps === undefined && { write: log }),
			});
		},
		async onTestRunEnd(
			testModules: ReadonlyArray<TestModule>,
			_unhandledErrors,
			reason,
		) {
			const current = run;
			run = undefined;
			if (current === undefined) return;
			if (reason === "interrupted") {
				current.cancel();
				return;
			}
			await current.finish(
				testModules.map((testModule) => ({
					file: testModule.moduleId,
					failed: testModule.state() === "failed",
				})),
			);
		},
	};
}

/**
 * Vitest's own default reporters with the adapter after them, for a config
 * that names none. Setting `reporters` replaces the defaults, and one of
 * them exists only on GitHub Actions: writing `["default", variant()]` into
 * such a config would quietly take the annotations off every pull request.
 */
export function variantReporters(
	options: VariantReporterOptions = {},
): Array<string | Reporter> {
	return [
		"default",
		...(process.env["GITHUB_ACTIONS"] === "true" ? ["github-actions"] : []),
		variantReporter(options),
	];
}

export default variantReporter;
