import { describe, expect, it } from "vitest";
import type { TraceFile } from "../../../tracer/types.js";
import { isCriticalChange } from "../critical-path.js";

// Minimal valid TraceFile factory.
function makeTrace(
	routes: Array<{ path: string; modules: string[] }> = [],
): TraceFile {
	return {
		schemaVersion: 1,
		sessionId: "test-session",
		startedAt: 1000,
		endedAt: 2000,
		framework: "next",
		modules: [],
		routes,
	};
}

describe("isCriticalChange", () => {
	// ── Core invariant: no critical paths configured ─────────────────────────
	it("returns true when criticalPaths is empty (everything is critical)", () => {
		// If no critical paths are declared, variant cannot know what is safe
		// to skip — the only correct answer is to treat all changes as critical.
		const trace = makeTrace([{ path: "/checkout", modules: ["src/pay.ts"] }]);
		expect(isCriticalChange(["src/util.ts"], trace, [])).toBe(true);
	});

	// ── Changed file IS in a critical route ──────────────────────────────────
	it("returns true when a changed file is a module of a critical route", () => {
		const trace = makeTrace([
			{ path: "/checkout", modules: ["src/checkout.ts", "src/cart.ts"] },
		]);
		expect(isCriticalChange(["src/checkout.ts"], trace, ["/checkout"])).toBe(
			true,
		);
	});

	it("returns true when changed file appears in one of multiple critical routes", () => {
		const trace = makeTrace([
			{ path: "/checkout", modules: ["src/checkout.ts"] },
			{ path: "/login", modules: ["src/auth.ts"] },
		]);
		expect(
			isCriticalChange(["src/auth.ts"], trace, ["/checkout", "/login"]),
		).toBe(true);
	});

	// ── Changed file is NOT in any critical route ────────────────────────────
	it("returns false when changed file is NOT a module of any critical route", () => {
		const trace = makeTrace([
			{ path: "/checkout", modules: ["src/checkout.ts"] },
		]);
		// src/about.ts is not referenced by /checkout at all
		expect(isCriticalChange(["src/about.ts"], trace, ["/checkout"])).toBe(
			false,
		);
	});

	it("returns false when no files changed", () => {
		// Nothing changed → nothing is a critical change.
		const trace = makeTrace([
			{ path: "/checkout", modules: ["src/checkout.ts"] },
		]);
		expect(isCriticalChange([], trace, ["/checkout"])).toBe(false);
	});

	// ── Empty routes in trace session ────────────────────────────────────────
	it("returns false when trace has no routes recorded (footgun: documents known behavior)", () => {
		// If the trace session recorded zero routes (server started but no pages
		// were loaded), criticalModules will always be empty, so isCriticalChange
		// returns false and all builds are skipped — even if critical files changed.
		// This test documents that behavior so it is not accidentally "fixed" in
		// a way that silently changes the lint-only fast path.
		const trace = makeTrace([]); // no routes recorded
		expect(isCriticalChange(["src/checkout.ts"], trace, ["/checkout"])).toBe(
			false,
		);
	});

	// ── criticalPaths that don't match any trace route ───────────────────────
	it("returns false when criticalPaths don't match any route in the trace", () => {
		const trace = makeTrace([{ path: "/about", modules: ["src/about.ts"] }]);
		// /checkout is declared critical but was never recorded in this trace
		expect(isCriticalChange(["src/checkout.ts"], trace, ["/checkout"])).toBe(
			false,
		);
	});

	// ── Wildcard route matching ───────────────────────────────────────────────
	it("wildcard matches routes that start with the prefix segment", () => {
		const trace = makeTrace([
			{ path: "/admin/users", modules: ["src/admin/users.ts"] },
			{ path: "/admin/settings", modules: ["src/admin/settings.ts"] },
		]);
		expect(isCriticalChange(["src/admin/users.ts"], trace, ["/admin/*"])).toBe(
			true,
		);
	});

	it("wildcard does NOT match partial path segment names (exposes BUG 1)", () => {
		// /api/* should match /api/users but NOT /apiother.
		// Currently FAILS because matchRoute slices to "/api" and
		// "/apiother".startsWith("/api") === true.
		// Fix: use `route === prefix || route.startsWith(prefix + "/")`.
		const trace = makeTrace([
			{ path: "/apiother", modules: ["src/apiother.ts"] },
		]);
		expect(isCriticalChange(["src/apiother.ts"], trace, ["/api/*"])).toBe(
			false,
		); // EXPECTED TO FAIL until BUG 1 is fixed
	});

	it("exact match: /api does not match /api/users without wildcard", () => {
		const trace = makeTrace([
			{ path: "/api/users", modules: ["src/users.ts"] },
		]);
		// Exact match — /api !== /api/users
		expect(isCriticalChange(["src/users.ts"], trace, ["/api"])).toBe(false);
	});

	// ── File appears in multiple routes ──────────────────────────────────────
	it("returns true when a shared module appears in both critical and non-critical routes", () => {
		const trace = makeTrace([
			{ path: "/checkout", modules: ["src/shared.ts"] },
			{ path: "/about", modules: ["src/shared.ts"] },
		]);
		// shared.ts is critical because /checkout uses it
		expect(isCriticalChange(["src/shared.ts"], trace, ["/checkout"])).toBe(
			true,
		);
	});

	// ── Multiple changed files, only one critical ────────────────────────────
	it("returns true when at least one of many changed files is critical", () => {
		const trace = makeTrace([
			{ path: "/checkout", modules: ["src/checkout.ts"] },
		]);
		expect(
			isCriticalChange(
				["src/about.ts", "src/docs.ts", "src/checkout.ts"],
				trace,
				["/checkout"],
			),
		).toBe(true);
	});
});
