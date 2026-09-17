/**
 * @module
 * Vite plugin for module-level tracing.
 *
 *   import { variantVitePlugin } from "link/tracer";
 *   export default { plugins: [variantVitePlugin()] };
 */

import type { TraceFile, TracerOptions } from "./types.js";
import { newSessionId, writeTrace } from "./writer.js";

interface ViteBundleChunk {
	type: "chunk" | "asset";
	isEntry?: boolean;
	facadeModuleId?: string | null;
	moduleIds?: string[];
}

interface VitePlugin {
	name: string;
	configResolved?: (cfg: { root: string }) => void;
	transform?: (_code: string, id: string) => null;
	generateBundle?: (
		options: unknown,
		bundle: Record<string, ViteBundleChunk>,
	) => void;
	closeBundle?: () => Promise<void>;
}

// Map an entry file path to a URL route using common Vite project conventions.
function fileToRoute(filePath: string, root: string): string | null {
	const rel = filePath.replace(root, "").replace(/\\/g, "/");
	const m = rel.match(/^\/(?:src\/)?(?:pages|routes|views)\/(.+)\.[jt]sx?$/);
	if (!m?.[1]) return null;
	const path =
		`/${m[1]}`.replace(/\/index$/, "").replace(/\[(.+?)\]/g, ":$1") || "/";
	return path;
}

export function variantVitePlugin(options: TracerOptions = {}): VitePlugin {
	const sessionId = options.sessionId ?? newSessionId();
	const startedAt = Date.now();
	const seen = new Set<string>();
	const routeModules = new Map<string, string[]>();
	let root = process.cwd();

	return {
		name: "variant-tracer",
		configResolved(cfg) {
			root = cfg.root;
		},
		transform(_code, id) {
			if (id && !id.includes("node_modules")) {
				seen.add(id.split("?")[0] ?? id);
			}
			return null;
		},
		generateBundle(_opts, bundle) {
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk" || !chunk.isEntry || !chunk.facadeModuleId)
					continue;
				const routePath = fileToRoute(chunk.facadeModuleId, root);
				if (routePath === null) continue;
				const modules = (chunk.moduleIds ?? [])
					.filter((id) => !id.includes("node_modules"))
					.sort();
				if (modules.length > 0) routeModules.set(routePath, modules);
			}
		},
		async closeBundle() {
			const routes = [...routeModules.entries()].map(([path, modules]) => ({
				path,
				modules,
			}));
			const trace: TraceFile = {
				schemaVersion: 1,
				sessionId,
				startedAt,
				endedAt: Date.now(),
				framework: "vite",
				modules: [...seen].sort().map((file) => ({ file })),
				routes,
			};
			await writeTrace(root, trace, options.outDir);
		},
	};
}
