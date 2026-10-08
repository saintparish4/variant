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
and names are sorted. `-q` keeps the JSON and drops everything else; `-qq`
suppresses the JSON too.

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
	/** How baseRef was chosen. */
	baseSource: "flag" | "environment" | "pull-request" | "push" | "default-branch" | "previous-commit";
	/** What baseRef stands for, in words: "merge base with origin/main". */
	baseLabel: string;
	/** The commit the prediction was recorded against; null outside a repository. */
	headSha: string | null;
	verdict: BuildVerdict;
	/** Workspace packages discovery found; 0 outside a workspace. */
	packagesFound: number;
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
	/** 1 when this change fully resolved; 0.1 lower per note, floor 0.3. */
	confidence: number;
	/** What could not be resolved about this change. */
	notes: string[];
	/** Standing gaps in the graph, the same whatever changed. Not scored. */
	repositoryNotes: string[];
};

type FileImpact = {
	filePath: string;
	classification: "non-impacting" | "internal" | "breaking" | "unanalyzed";
	/** Exports whose public shape changed or that were removed. */
	impactedSymbols: string[];
	/** True for `breaking`: the change reaches dependents that import impactedSymbols. */
	propagates: boolean;
	/**
	 * Present and true when no dependent is gated out by the names it imports:
	 * a changed `export *`, or a file that does not parse.
	 */
	ungated?: boolean;
	notes: string[];
};

type TestImpact = {
	/** Test files to run. Every known test file when selectAll is true. */
	affectedTests: string[];
	totalTests: number;
	/** True when a package manifest, lockfile, tsconfig or test/build config changed. */
	selectAll: boolean;
	/**
	 * Changed files no test reaches, directly or through the files that import
	 * them: TypeScript or not, prose and deleted files nothing imports aside.
	 */
	unreached: string[];
	/** Changed test files that are JavaScript, which variant cannot select. */
	unselectedTests: string[];
	/** JavaScript test files in the workspace. None is in totalTests. */
	javascriptTests: number;
	/**
	 * radius.confidence, lowered 0.1 per test note, floor 0.3. 1 when selectAll
	 * is true; at most 0.5 when unreached or unselectedTests is not empty.
	 */
	confidence: number;
	/** confidence bucketed: "high" at 0.9 and up, "medium" from 0.7, "low" below. */
	resolution: "high" | "medium" | "low";
	/** What could not be resolved about this change. */
	notes: string[];
	/** Standing gaps, the same whatever changed. Not scored. */
	repositoryNotes: string[];
};
```

The human output's `Confidence` is `tests.resolution` followed by
`tests.confidence` as a percentage.

Example, from step 2 of the [tutorial](./tutorial.md#2-a-breaking-change):

```json
{
  "baseRef": "main",
  "baseSource": "flag",
  "baseLabel": "main",
  "verdict": "build-required",
  "packagesFound": 3,
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
    "notes": [],
    "repositoryNotes": []
  },
  "tests": {
    "affectedTests": [
      "packages/shop/src/cart.test.ts",
      "packages/utils/src/price.test.ts"
    ],
    "totalTests": 4,
    "selectAll": false,
    "unreached": [],
    "unselectedTests": [],
    "javascriptTests": 0,
    "confidence": 1,
    "resolution": "high",
    "notes": [],
    "repositoryNotes": []
  }
}
```

Notes are human-readable strings, sorted. The forms they take:

| Where | Note |
|---|---|
| `radius.notes` | `<n> changed file(s) is/are not TypeScript and was/were not analyzed (<file>, …)` |
| `radius.notes` | `<n> changed TypeScript file(s) is/are in a directory variant does not index and was/were not analyzed (<file>, …)` |
| `radius.notes` | `<n> changed file(s) is/are outside the directory variant ran in and was/were not analyzed (<file>, …)` |
| `radius.notes` | `<dependent>: dynamic import of <file> — names unknowable` |
| `radius.notes` | `<n> affected file(s) has/have unresolved imports: <file> (<specifier>, …), …` |
| `radius.notes` | `<n> file(s) in a package this change touches load a module through a fully computed import() or require() specifier (<file>, …); a changed file reached only that way selects no tests` |
| `radius.notes` | `<n> changed file(s) belong(s) to <name>, a local package variant did not find as a workspace package (<file>, …); files importing it by name are not reached` |
| `radius.notes` | `<file>: <reason the export surface could not be fully resolved>` |
| `radius.repositoryNotes` | `<n> file(s) load a module through a fully computed import() or require() specifier (<file>, …); a change reached only that way selects no tests` |
| `radius.repositoryNotes` | `<n> dependency/dependencies declared with a local protocol is/are not a workspace package variant found (<name>, …); …` |
| `radius.repositoryNotes` | `<n> bare import name(s) is/are neither workspace packages nor declared dependencies (<name>, …); …` |
| `tests.notes` | `<file>: build/test configuration changed — running all tests` |
| `tests.notes` | `<n> selected test file(s) have unresolved imports in their closure — fixtures or assets may be missed` |
| `tests.notes` | `<n> changed test file(s) is/are JavaScript, which variant does not index, and was/were not selected (<file>, …)` |
| `tests.notes` | `<n> JavaScript test file(s) in a package this change touches cannot be selected (<file>, …)` |
| `tests.repositoryNotes` | `<n> JavaScript test file(s) is/are not indexed (<file>, …); variant cannot select it/them, and code only it/they import(s) looks untested` |

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
	/** Test files in the runner's report(s). */
	ranTests: number;
	/** How many of those the prediction selected; all of them on a select-all. */
	predictedRan: number;
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
		/** Every file the branch changed, TypeScript or not. */
		changedFiles: string[];
		tsFilesChanged: number;
		files: FileClassification[];
		verdict: BuildVerdict;
	};
	plan: VerificationPlan;
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
	/** True when either version does not parse; the file is then `breaking`. */
	syntaxErrors: boolean;
};

type VerificationPlan = {
	baseRef: string;
	baseLabel: string;
	/** Highest risk first. */
	changes: {
		filePath: string;
		classification: "non-impacting" | "internal" | "breaking" | "unanalyzed";
		/** Exported names whose shape changed or that were removed. */
		symbols: string[];
		/** True when its exports only gained names: a new file, or new exports. */
		additive: boolean;
		/** Files importing it, directly or through other files. */
		dependents: number;
		/** Packages other than its own that those files are in. */
		crossesInto: string[];
		/** Test files that reach it. */
		tests: number;
		risk: "high" | "medium" | "low" | "unrated" | "none";
		/** The rule that set `risk`, in words. */
		reason: string;
	}[];
	tests: {
		selected: number;
		total: number;
		/** True when every test is in the plan, whatever it imports. */
		all: boolean;
		runs: {
			runner: "vitest" | "jest" | "unknown";
			/** Directory of the config the files run under; "" for the root. */
			dir: string;
			files: string[];
			/** The `test` script of the files' package. It runs the whole suite. */
			command?: string;
		}[];
		/** Test file -> import chain from it to the nearest changed file. */
		why: Record<string, string[]>;
	};
	checks: {
		kind: "typecheck" | "build" | "lint" | "e2e";
		package: string;
		dir: string;
		script: string;
		command: string;
	}[];
	/** Why the plan holds more than the import graph alone would select. */
	widened: string[];
	notVerified: {
		filePath: string;
		symbols: string[];
		/** Files importing it directly. */
		usedBy: string[];
		reason: string;
	}[];
	/** How much of the change the graph resolved. Not a safety figure. */
	resolution: "high" | "medium" | "low";
	notes: string[];
	repositoryNotes: string[];
};
```

`kind` is `signature` for a runtime-visible change (parameters, return type,
value type), `type` for a type-space-only change (interfaces, type aliases), and
`body` for an implementation-only change.

`risk` follows one rule, applied in this order:

| Risk | When |
|---|---|
| `none` | Only comments or formatting changed, or the file is documentation |
| `medium` | The file configures every test and build (a manifest, a lockfile, a `tsconfig`, a runner config) |
| `unrated` | Repository housekeeping no test can import: `.github/`, `.husky/`, `.vscode/`, `.gitignore`, `.gitattributes`, `.editorconfig`, a license |
| `high` | No test reaches the file |
| `low` | It is a test file |
| `low` | Its exports only gained names (a new file, or new exports), and a test reaches it |
| `high` | Its exports changed, and a file in another package imports it |
| `medium` | Its exports changed; or variant cannot read the file |
| `low` | Only its implementation changed, and at least one test reaches it |

An `unrated` file still matters; a test plan has nothing to say about it, so it
is listed and kept out of "not verified".

"Reaches" means imports, directly or through other files. A test that reaches
a file does not necessarily exercise what changed in it.

`checks` are the `typecheck`, `build`, `lint` and end-to-end scripts, recognized
by name, of each package holding an affected file. variant plans them and runs
none. Unit-test scripts are left out, because `tests` lists the files.

With `--output <file>`, the file holds the JSON without a trailing newline, and
stdout gets `Report written to <file>`.

#### Markdown (`--markdown`)

```markdown
## Variant PR Report

2 changed files against `main`.

### What changed

| Risk | File | Change | Reached by | Why |
|------|------|--------|------------|-----|
| **high** | `packages/utils/src/legacy.ts` | internal | 0 files, 0 test files | no test reaches it |
| **high** | `packages/utils/src/price.ts` | breaking: `formatPrice` | 4 files, into `web`, 2 test files | its exports changed, and other packages import it |

### What to verify

**Tests:** 2 of 31 test files.

- Vitest in `packages/utils`: 1 file
- Vitest in `apps/web`: 1 file

<details><summary>Why these tests</summary>

Each line is the import chain from a test to a file this change touches.

- `apps/web/src/cart.test.ts` → `apps/web/src/cart.ts` → `packages/utils/src/index.ts` → `packages/utils/src/price.ts`
- `packages/utils/src/price.test.ts` → `packages/utils/src/price.ts`

</details>

**Checks** in the packages this change affects:

- typecheck: `pnpm --filter utils run typecheck`
- typecheck: `pnpm --filter web run typecheck`
- build: `pnpm --filter web run build`

### Not verified

- `packages/utils/src/legacy.ts`: no test reaches it: it is untested, or used in a way variant cannot follow. Nothing variant indexes imports it.

<sub>Graph resolution: low. It says how much of this change variant could follow, not how safe the change is. Reaching a file is not the same as testing what changed in it.</sub>
```

- The first line is always `## Variant PR Report`, which is what lets a
  workflow find and update its own comment.
- Tables and lists stop at 25 rows and say how many were left out; the JSON
  has all of them.
- A group of tests run by Jest is followed by a line saying that variant has
  no Jest adapter yet, so those runs are not compared with the plan.
- **Wider than the import graph** appears when a change selects every test
  (configuration) or reaches every importer of a file regardless of the names
  it takes.
- With nothing changed, everything after the first paragraph is replaced by
  `_Nothing changed against the base._`.

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
	/** The prediction's tests.confidence. Absent from older records. */
	confidence?: number;
	/** The prediction's selectAll. Absent from older records. */
	selectAll?: boolean;
	/** Test files in the runner's report(s). Absent from older records. */
	ranTests?: number;
	/** How many of those the prediction selected. Absent from older records. */
	predictedRan?: number;
};
```

`totalTests` is every file variant takes for a test, which can be more than a
run executes: helpers under `__tests__/`, or suites another job runs. The share
of a run the prediction would have skipped is therefore
`1 - predictedRan / ranTests`, not `1 - predictedTests / totalTests`.

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
