/**
 * The supported public API surface of variant.
 *
 * Depend only on what is exported here. Symbols reachable through deep import
 * paths (`@blzsky/variant/dist/...`) are `@internal` and may change at any time. While the
 * package is `0.x`, even this surface can break in a minor release; every break
 * is recorded in the CHANGELOG.
 *
 * @packageDocumentation
 */

/**
 * Wrap your config object with this helper to get TypeScript type-checking
 * and IDE autocomplete. The value is returned as-is at runtime.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@blzsky/variant";
 *
 * export default defineConfig({
 *   tasks: {
 *     build: { command: "npm run build", inputs: ["src/**"] },
 *   },
 * });
 * ```
 *
 * @public
 */
export { defineConfig } from "./core/config/loader.js";
/**
 * The raw config shape accepted by `defineConfig`. All fields are optional;
 * Variant applies defaults for anything not specified.
 *
 * @public
 */
/**
 * The `cache` sub-object of `ResolvedVariantConfig`, with all defaults
 * applied.
 *
 * @public
 */
/**
 * The fully-validated config with every default filled in. This is the type
 * of the config object that Variant uses internally after loading.
 *
 * @public
 */
/**
 * `"adaptive"` or `"strict"`.
 *
 * @public
 */
/**
 * A single task entry inside `VariantConfig["tasks"]`.
 *
 * @example
 * ```typescript
 * const myTask: TaskConfig = {
 *   command: "npm run build",
 *   inputs: ["src/**"],
 *   dependsOn: ["typecheck"],
 * };
 * ```
 *
 * @public
 */
export type {
	CacheConfig,
	ResolvedVariantConfig,
	Strategy,
	TaskConfig,
	VariantConfig,
} from "./types/index.js";
