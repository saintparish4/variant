import { bunAdapter } from "../../adapters/runtimes/bun.js";
import { denoAdapter } from "../../adapters/runtimes/deno.js";
import { nodeAdapter } from "../../adapters/runtimes/node.js";
import type { RuntimeAdapter } from "../../adapters/types.js";
import type { RuntimeInfo } from "../../types/index.js";

/**
 * Detects the active runtime from process globals (fast, no subprocess)
 * Falls back to probing via subprocess if globals are unavailable
 * Always returns a RuntimeAdapter -- falls back to node
 */
export function detectRuntime(): RuntimeAdapter {
	// Globals are free to check; probing for a binary costs a subprocess.
	const g = globalThis as Record<string, unknown>;
	if (typeof g["Bun"] !== "undefined") {
		return bunAdapter;
	}
	if (typeof g["Deno"] !== "undefined") {
		return denoAdapter;
	}
	// No Bun/Deno global means we are running under Node, whatever else may
	// also be installed on the machine.
	return nodeAdapter;
}

/**
 * Builds a RuntimeInfo value for VariantContext from an adapter
 * primary: the detected runtime name
 * fallback: always "node" (guaranteed to be available in most environments)
 */
export function toRuntimeInfo(adapter: RuntimeAdapter): RuntimeInfo {
	return {
		primary: adapter.name,
		fallback: adapter.name === "node" ? "node" : "node",
	};
}
