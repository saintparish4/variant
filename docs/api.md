# API reference

variant has two programmatic surfaces:

1. **The package exports**: `defineConfig` and the config types, imported from
   `@blzsky/variant`.
2. **The machine-readable output**: the JSON that `impact`, `impact verify`,
   `workspace check` and `pr report` print, the `pr report` markdown, and the
   history files under `.variant/history/`. This is what CI scripts consume.

For commands and flags, see the [CLI reference](./cli-reference.md).

> **Stability.** variant is `0.x`: either surface can change in a minor
> release, and every change is recorded in the [CHANGELOG](../CHANGELOG.md).
> Only what `@blzsky/variant` exports is supported. Deep imports
> (`@blzsky/variant/dist/...`) are internal and can change at any time.

- [Package exports](#package-exports)
  - [`defineConfig`](#defineconfig)
  - [Config types](#config-types)
- [JSON output](#json-output)
  - [`impact --json`](#impact---json)
  - [`impact verify --json`](#impact-verify---json)
  - [`workspace check --json`](#workspace-check---json)
  - [`pr report`](#pr-report)
- [History files](#history-files)
- [Shared values](#shared-values)

---

## Package exports

The package is ESM-only. Types ship with it.

```ts
import {
	defineConfig,
	type CacheConfig,
	type ResolvedVariantConfig,
	type Strategy,
	type TaskConfig,
	type VariantConfig,
} from "@blzsky/variant";
```

### `defineConfig`

```ts
function defineConfig(config: VariantConfig): VariantConfig;
```

Returns its argument unchanged. It exists so `variant.config.ts` gets type
checking and editor completion:

```ts
// variant.config.ts
import { defineConfig } from "@blzsky/variant";

export default defineConfig({
	tasks: {
		typecheck: { command: "tsc --noEmit", inputs: ["src/**/*.ts", "tsconfig.json"] },
		build: { command: "tsup", inputs: ["src/**/*.ts"], dependsOn: ["typecheck"] },
	},
});
```

Validation happens when the CLI loads the file, not in `defineConfig`. An
unknown `dependsOn` target, for example, is reported by `variant check` or
`variant doctor`.

### Config types

`VariantConfig` is what you write: every field is optional. `ResolvedVariantConfig`
is the same object after validation, with defaults filled in. Each field is
documented in the [config reference](./config-reference.md).

```ts
type VariantConfig = {
	strategy?: "adaptive" | "strict";
	cache?: {
		mode?: "content";
		directory?: string;
		ttlDays?: number;
	};
	tasks?: Record<string, TaskConfig>;
	workspace?: { enabled?: boolean; scripts?: string[] };
	git?: { baseRef?: string; enabled?: boolean };
	semanticDiff?: { enabled?: boolean };
	scheduler?: { policy?: "auto" | "light-first" | "pack-heavy" | "critical-path" };
};

type TaskConfig = {
	command?: string;
	inputs?: string[];
	dependsOn?: string[];
	cpuHeavy?: boolean;
};
```

| Type | Definition |
|---|---|
| `ResolvedVariantConfig` | `VariantConfig` with defaults applied: `strategy` is `"adaptive"`, `cache` is `{ mode: "content", directory: ".variant/cache" }`, `tasks` is `{}`. `workspace`, `git`, `semanticDiff` and `scheduler` stay `undefined` when omitted; their inner defaults apply only when the object is present. |
| `Strategy` | `"adaptive" \| "strict"` |
| `TaskConfig` | One entry of `tasks`, as above |
| `CacheConfig` | `ResolvedVariantConfig["cache"]`: `{ mode: "content"; directory: string; ttlDays?: number }` |

---

## JSON output

All JSON is printed to stdout with two-space indentation. Paths are relative to
the directory variant ran in and always use `/`, on Windows too. Arrays of paths
and names are sorted. `-q` suppresses JSON along with all other output.

When there is nothing to analyze, the commands print a plain-text line instead
of JSON and exit 0. Check the exit code, and that stdout starts with `{`,
before parsing. A `--base` ref that cannot be resolved is not in this table: it
is an error (`GIT_REF_ERROR`, exit 1).

| Command | Plain-text line printed instead of JSON |
|---|---|
| `impact verify --json` | `impact verify: no logged prediction to reconcile against. …` |
| `workspace check --json` | `workspace check: no workspace packages found …` |

### `impact --json`

```ts
type ImpactReport = {
	baseRef: string;
	verdict: BuildVerdict;
	/** False when the prediction could not be appended to .variant/history/impact.jsonl. */
	historyLogged: boolean;
	radius: BlastRadius;
	tests: TestImpact;
};

type BlastRadius = {
	baseRef: string;
	changed: FileImpact[];
	/** Changed files that need work, plus every file the change propagates to. */
	affectedFiles: string[];
	/** Workspace package names that contain an affected file. */
	affectedPackages: string[];
	/** Always [] from `impact`. */
	affectedTasks: string[];
	/** 1 when every import resolved; 0.1 lower per note, floor 0.3. */
	confidence: number;
	notes: string[];
};

type FileImpact = {
	filePath: string;
	classification: "non-impacting" | "internal" | "breaking" | "unanalyzed";
	/** Exports whose public shape changed or that were removed. */
	impactedSymbols: string[];
	/** True for `breaking`: the change reaches dependents that import impactedSymbols. */
	propagates: boolean;
	notes: string[];
};

type TestImpact = {
	/** Test files to run. Every known test file when selectAll is true. */
	affectedTests: string[];
	totalTests: number;
	/** True when a package manifest, lockfile, tsconfig or test/build config changed. */
	selectAll: boolean;
	/** radius.confidence, lowered 0.1 per test note, floor 0.3. */
	confidence: number;
	notes: string[];
};
```

The human output's `Confidence` is `tests.confidence`.

Example, from step 2 of the [tutorial](./tutorial.md#2-a-breaking-change):

```json
{
  "baseRef": "main",
  "verdict": "build-required",
  "historyLogged": true,
  "radius": {
    "baseRef": "main",
    "changed": [
      {
        "filePath": "packages/utils/src/price.ts",
        "classification": "breaking",
        "impactedSymbols": ["formatPrice"],
        "propagates": true,
        "notes": []
      },
      {
        "filePath": "packages/utils/src/slug.ts",
        "classification": "non-impacting",
        "impactedSymbols": [],
        "propagates": false,
        "notes": []
      }
    ],
    "affectedFiles": [
      "packages/shop/src/cart.test.ts",
      "packages/shop/src/cart.ts",
      "packages/utils/src/price.test.ts",
      "packages/utils/src/price.ts"
    ],
    "affectedPackages": ["@acme/shop", "@acme/utils"],
    "affectedTasks": [],
    "confidence": 1,
    "notes": []
  },
  "tests": {
    "affectedTests": [
      "packages/shop/src/cart.test.ts",
      "packages/utils/src/price.test.ts"
    ],
    "totalTests": 4,
    "selectAll": false,
    "confidence": 1,
    "notes": []
  }
}
```

Notes are human-readable strings, sorted. The forms they take:

| Where | Note |
|---|---|
| `radius.notes` | `<file>: not a TypeScript source; change not analyzed` |
| `radius.notes` | `<dependent>: dynamic import of <file> — names unknowable` |
| `radius.notes` | `<file>: unresolved imports (<specifier>, …)` |
| `radius.notes` | `<file>: <reason the export surface could not be fully resolved>` |
| `tests.notes` | `<file>: build/test configuration changed — running all tests` |
| `tests.notes` | `<n> selected test file(s) have unresolved imports in their closure — fixtures or assets may be missed` |

### `impact verify --json`

```ts
type VerifyResult = {
	/** How the prediction was found: by --head-sha, or the newest logged. */
	matchedBy: "head-sha" | "most-recent";
	/** Test files the runner reported as failed. */
	failedTests: string[];
	/** Failures inside the predicted set. */
	caught: string[];
	/** Failures outside it: skipping would have missed these. */
	falseSkips: string[];
	/** falseSkips.length / failedTests.length; 0 when nothing failed. */
	falseSkipRate: number;
	/** False when the reconciliation could not be appended to the history. */
	historyLogged: boolean;
	/** ISO timestamp of the prediction that was reconciled. */
	predictedAt: string;
	baseRef: string;
};
```

A report is read as Jest's `--json` shape, which Vitest's `--reporter=json`
also produces: a top-level `testResults` array whose entries have a `name` (the
test file path) and a `status`. An entry counts as failed when `status` is
`"failed"`. When the prediction was a select-all, every failure counts as
caught.

A clean run has a `falseSkipRate` of 0, and that is evidence of nothing. The
rate means something only once many runs with failures have been reconciled.

### `workspace check --json`

```ts
type WorkspaceCheckResult = {
	packagesChecked: number;
	/** Sorted by package, then target, then kind. */
	violations: WorkspaceViolation[];
};

type WorkspaceViolation = {
	kind: "undeclared-workspace-dep" | "undeclared-external-dep" | "cross-package-relative-import";
	/** The workspace package that has the offending import. */
	package: string;
	/** The package it imports. */
	target: string;
	/** Files containing the import. */
	files: string[];
};
```

```json
{
  "packagesChecked": 3,
  "violations": [
    {
      "kind": "undeclared-workspace-dep",
      "package": "@acme/shop",
      "target": "@acme/blog",
      "files": ["packages/shop/src/product.ts"]
    }
  ]
}
```

The command exits 1 whenever `violations` is non-empty, `--json` or not.

### `pr report`

#### JSON (default)

```ts
type PrReport = {
	/** ISO timestamp. */
	generatedAt: string;
	check: {
		baseRef: string;
		tsFilesChanged: number;
		files: FileClassification[];
		verdict: BuildVerdict;
	};
};

type FileClassification = {
	filePath: string;
	classification: "non-impacting" | "internal" | "breaking";
	exportedSymbols: {
		added: string[];
		removed: string[];
		changed: { name: string; kind: "signature" | "body" | "type" }[];
	};
	/** 1 when the export surface fully resolved; 0.15 lower per note, floor 0.3. */
	confidence: number;
	/** Why confidence was lowered. Empty when it is 1. */
	confidenceNotes: string[];
};
```

`kind` is `signature` for a runtime-visible change (parameters, return type,
value type), `type` for a type-space-only change (interfaces, type aliases), and
`body` for an implementation-only change.

```json
{
  "generatedAt": "2026-09-24T22:38:12.380Z",
  "check": {
    "baseRef": "main",
    "tsFilesChanged": 2,
    "files": [
      {
        "filePath": "packages/utils/src/price.ts",
        "classification": "breaking",
        "exportedSymbols": {
          "added": [],
          "removed": [],
          "changed": [{ "name": "formatPrice", "kind": "signature" }]
        },
        "confidence": 1,
        "confidenceNotes": []
      },
      {
        "filePath": "packages/utils/src/slug.ts",
        "classification": "non-impacting",
        "exportedSymbols": { "added": [], "removed": [], "changed": [] },
        "confidence": 1,
        "confidenceNotes": []
      }
    ],
    "verdict": "build-required"
  }
}
```

With `--output <file>`, the file holds the JSON without a trailing newline, and
stdout gets `Report written to <file>`.

#### Markdown (`--markdown`)

```markdown
## Variant PR Report

**Generated:** 2026-09-24T22:31:58.071Z
**Base ref:** `main`

### Semantic Diff

🔴 **Build required**

| File | Classification | API Changes |
|------|----------------|-------------|
| `packages/utils/src/price.ts` | breaking | ~1 |
| `packages/utils/src/slug.ts` | non-impacting | — |
```

- The first line is always `## Variant PR Report`, which is what lets a
  workflow find and update its own comment.
- The verdict line is `✅ **Safe to skip build**`, `⚠️ **Build recommended**` or
  `🔴 **Build required**`.
- **API Changes** counts exported symbols added (`+N`), removed (`-N`) and
  changed (`~N`), or `—` when none did.
- With no TypeScript changes, the table is replaced by
  `_No TypeScript files changed._`.

---

## History files

Both files are JSON Lines: one JSON object per line, appended by each run and
trimmed to the newest 1000 records. Writes are best-effort: a failure sets
`historyLogged: false` in the command's JSON and does not fail the command.

### `.variant/history/impact.jsonl`

One record per `impact` run:

```ts
type ImpactPrediction = {
	/** ISO timestamp. */
	at: string;
	baseRef: string;
	/** Full SHA of HEAD when the prediction was made; null outside a git repository. */
	headSha: string | null;
	changedFiles: string[];
	/** A count here, not the list printed by impact --json. */
	affectedFiles: number;
	affectedPackages: string[];
	/** The predicted run set that impact verify diffs failures against. */
	affectedTests: string[];
	totalTests: number;
	selectAll: boolean;
	verdict: BuildVerdict;
	/** tests.confidence. */
	confidence: number;
	/** Radius notes, then test notes. */
	notes: string[];
};
```

### `.variant/history/reconciliation.jsonl`

One record per `impact verify` run. Counts rather than lists, so the rate can
be summed across runs:

```ts
type ImpactReconciliation = {
	at: string;
	headSha: string | null;
	baseRef: string;
	predictedTests: number;
	totalTests: number;
	failedTests: number;
	/** Failures inside the predicted set. */
	caught: number;
	/** Failures outside it: the number that gates test skipping. */
	falseSkips: number;
};
```

The false-skip rate across every reconciled run:

```bash
node -e '
const lines = require("node:fs").readFileSync(".variant/history/reconciliation.jsonl", "utf8").trim().split("\n");
const runs = lines.map((line) => JSON.parse(line));
const failed = runs.reduce((sum, run) => sum + run.failedTests, 0);
const missed = runs.reduce((sum, run) => sum + run.falseSkips, 0);
console.log(`${runs.length} runs, ${missed}/${failed} failures would have been skipped`);
'
```

---

## Shared values

### `BuildVerdict`

```ts
type BuildVerdict = "safe-to-skip" | "build-recommended" | "build-required";
```

| Value | Human output | When |
|---|---|---|
| `build-required` | `build required` | Any file is `breaking`; for `impact`, also when every test was selected |
| `build-recommended` | `build recommended` | Any file is `internal`; for `impact`, also `unanalyzed` |
| `safe-to-skip` | `safe to skip build` | Everything else |
