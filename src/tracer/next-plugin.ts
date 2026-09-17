/**
 * @module
 * Next.js webpack plugin for module-level tracing. Consumed by the user as:
 *
 *   const { variantNextPlugin } = require("link/tracer");
 *   module.exports = {
 *     webpack(config) {
 *       config.plugins.push(variantNextPlugin());
 *       return config;
 *     },
 *   };
 */

import type { TraceFile, TracerOptions } from "./types.js";
import { newSessionId, writeTrace } from "./writer.js";

interface WebpackCompiler {
	hooks: {
		afterCompile: {
			tap: (
				name: string,
				cb: (compilation: WebpackCompilation) => void,
			) => void;
		};
		done: { tapPromise: (name: string, cb: () => Promise<void>) => void };
	};
	context: string;
}

interface WebpackCompilation {
	modules: Iterable<{ resource?: string }>;
	entrypoints?: Map<string, WebpackEntrypoint>;
	chunkGraph?: {
		getChunkModulesIterable: (
			chunk: unknown,
		) => Iterable<{ resource?: string }>;
	};
}

interface WebpackEntrypoint {
	chunks?: Iterable<unknown>;
}

// Next.js entrypoint name → URL route path. Returns null for internals to skip.
function entryNameToRoute(name: string): string | null {
	if (
		/^(_app|_document|_error|main|webpack|polyfills|runtime|framework|commons)/.test(
			name,
		)
	)
		return null;
	const cleaned = name
		.replace(/^pages/, "")
		.replace(/^app/, "")
		.replace(/\/page$/, "")
		.replace(/\/index$/, "");
	const route = cleaned || "/";
	return route.startsWith("/") ? route : `/${route}`;
}

// Fallback: derive route entries from page file paths when chunkGraph is unavailable.
// Uses lastIndexOf so a project root named "app" (e.g. Docker /app/) doesn't shadow
// the Next.js app-router directory deeper in the path.
function deriveRoutesFromFiles(
	files: string[],
): Array<{ path: string; modules: string[] }> {
	const skipRe =
		/[/\\](_app|_document|_error|layout|loading|error|not-found)\.[jt]sx?$/;
	const result: Array<{ path: string; modules: string[] }> = [];
	for (const file of files) {
		if (skipRe.test(file)) continue;
		const normalized = file.replace(/\\/g, "/");
		let routeSegment: string | undefined;
		for (const marker of ["/pages/", "/app/"]) {
			const idx = normalized.lastIndexOf(marker);
			if (idx === -1) continue;
			const afterMarker = normalized.slice(idx + marker.length);
			const m = afterMarker.match(/^(.+)\.[jt]sx?$/);
			if (m?.[1]) {
				routeSegment = m[1];
				break;
			}
		}
		if (!routeSegment) continue;
		const route =
			`/${routeSegment}`.replace(/\/page$/, "").replace(/\/index$/, "") || "/";
		result.push({ path: route, modules: [file] });
	}
	return result;
}

export function variantNextPlugin(options: TracerOptions = {}) {
	const sessionId = options.sessionId ?? newSessionId();
	const startedAt = Date.now();
	const seen = new Set<string>();
	const entrypointModules = new Map<string, Set<string>>();

	return {
		apply(compiler: WebpackCompiler) {
			compiler.hooks.afterCompile.tap("VariantTracer", (compilation) => {
				for (const m of compilation.modules) {
					if (m.resource && !m.resource.includes("node_modules")) {
						seen.add(m.resource);
					}
				}

				for (const [name, entry] of compilation.entrypoints ?? new Map()) {
					const routePath = entryNameToRoute(name);
					if (routePath === null) continue;
					const files = entrypointModules.get(routePath) ?? new Set<string>();
					for (const chunk of entry.chunks ?? []) {
						if (compilation.chunkGraph) {
							for (const m of compilation.chunkGraph.getChunkModulesIterable(
								chunk,
							)) {
								if (m.resource && !m.resource.includes("node_modules")) {
									files.add(m.resource);
								}
							}
						}
					}
					if (files.size > 0) entrypointModules.set(routePath, files);
				}
			});

			compiler.hooks.done.tapPromise("VariantTracer", async () => {
				const routes =
					entrypointModules.size > 0
						? [...entrypointModules.entries()].map(([path, files]) => ({
								path,
								modules: [...files].sort(),
							}))
						: deriveRoutesFromFiles([...seen]);

				const trace: TraceFile = {
					schemaVersion: 1,
					sessionId,
					startedAt,
					endedAt: Date.now(),
					framework: "next",
					modules: [...seen].sort().map((file) => ({ file })),
					routes,
				};
				await writeTrace(compiler.context, trace, options.outDir);
			});
		},
	};
}
