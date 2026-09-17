/**
 * Build-tool tracer plugins. Part of the supported public API surface
 * (`vrnt/tracer`), under the same `0.x` stability terms as the main entry
 * point.
 *
 * @packageDocumentation
 */

/** Next.js / webpack tracer plugin. @public */
export { variantNextPlugin } from "./next-plugin.js";
/** @public */
export type { TraceFile, TraceModule, TracerOptions } from "./types.js";
/** Vite tracer plugin. @public */
export { variantVitePlugin } from "./vite-plugin.js";
/** @public */
export { newSessionId, writeTrace } from "./writer.js";
