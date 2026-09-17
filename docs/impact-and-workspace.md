# Impact analysis & workspace checks

Two commands that reason about your TypeScript source directly — no build step required:

- **`variant impact`** predicts which tests a change actually requires, so you can eventually skip the rest with confidence.
- **`variant workspace check`** is a CI gate that catches phantom dependencies and import-boundary violations in a monorepo.

Both are built on the same pipeline: a persisted symbol index (`.variant/graph/symbols.json`) → a file-level reverse import graph → semantic diffing of exported surfaces. That shared foundation is why both commands share the same limitations — see [Limitations](#limitations) below before you rely on either in CI.

## `variant impact`

Runs the full change-intelligence pipeline — signature differ → blast radius → test impact — and reports which test files you need to run for a given diff.

```bash
variant impact
variant impact --base origin/main
variant impact --json
```

**This is report-only.** No test skipping happens today. Every run appends its prediction to `.variant/history/impact.jsonl`, building a shadow-mode dataset of predicted-vs-actual outcomes. Test skipping only unlocks once the measured false-skip rate over that history is acceptable — the printed confidence score is a graph-resolution number, not a promise that it's safe to skip.

### How it classifies changes

Each changed `.ts`/`.tsx` file is classified by comparing its exported surface before/after:

| Classification | Meaning |
|---|---|
| `non-impacting` | No exported symbols changed (comments, whitespace, private code) — not even a seed for propagation |
| `internal` | Body-only change to an exported symbol — affects the file itself but does not propagate to importers |
| `breaking` | An exported symbol's signature changed or was removed — propagates to dependents |
| `unanalyzed` | Not a TypeScript source (e.g. `.json`, `.d.ts`) — the differ has nothing to compare |

Propagation past the first hop is structural (any dependent of a dependent is included), because a dependent's own inferred surface may change in ways single-file analysis can't see. The first hop is gated per symbol: a dependent that only imports names your change didn't touch is skipped.

### Output

```
Base ref: main

You changed 3 files.
  breaking       src/api/checkout.ts  (createOrder)
  internal       src/hooks/useCart.ts
  non-impacting  src/utils/format.ts

Impact: 12 files, 2 packages (@myapp/web, @myapp/checkout)

Run:   8 test files
Skip:  47 test files (of 55 total)

Verdict:    build required
Confidence: 82%  (report-only — run the full suite; skipping unlocks after shadow-mode validation)

Notes:
  - src/lib/legacy.ts: dynamic import of src/auth.ts — names unknowable
```

Verdicts reuse the same vocabulary as `pr check`:

| Verdict | Triggered when |
|---|---|
| `safe to skip build` | Every changed file is `non-impacting`, and no config select-all |
| `build recommended` | At least one file is `internal` (or `unanalyzed`) |
| `build required` | At least one file is `breaking`, or a build/test config file changed (select-all) |

### Options

| Flag | Default | Description |
|---|---|---|
| `--base <ref>` | `HEAD~1` | Git ref to diff against |
| `--json` | off | Print the full report (`radius` + `tests`) as JSON instead of the human summary |

### Select-all triggers

Certain changed paths invalidate the whole test suite regardless of import closure, because narrowing would be unsafe:

- `package.json`, lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`)
- `tsconfig*.json`
- Test/build runner configs (`vitest.config.*`, `jest.config.*`, `playwright.config.*`, `vite.config.*`)

## `variant impact verify`

`impact` records what variant thought. `impact verify` reads what actually
happened and diffs the two, which is the only thing that can ever earn the
right to skip a test.

```bash
# 1. predict, before the run
variant impact --base origin/main

# 2. run the full suite, keeping the machine-readable report
npx vitest run --reporter=json --outputFile=report.json
# (or: npx jest --json --outputFile=report.json)

# 3. reconcile
variant impact verify report.json
```

```
Prediction: 2026-09-17T22:38:46.120Z (2db3ee3f2de6d9344a099915a0fa229536216d03)
Matched by: head SHA

Predicted:  1 of 2 test files
Failed:     1 test file

Caught:      0 (inside the predicted set)
False skips: 1 (would have been missed)

False skips:
  src/__tests__/format.test.ts

False-skip rate this run: 100.0%
One run is not a rate. Reconcile many before reading anything into it.
```

A **false skip** is a test that failed and that the prediction did not select.
Had skipping been enabled, that failure would have shipped. This is the number
that gates test skipping; everything else `impact` prints describes a graph.

Each prediction records the commit it was made against, so `--head-sha <sha>`
reconciles a specific run rather than the most recent one — which is what CI
needs when several predictions are in flight. Each reconciliation is appended to
`.variant/history/reconciliation.jsonl` as counts, so a rate accumulates across
runs.

Two things this deliberately does not do:

- **It does not fail your build.** It reports; the suite you already ran decides
  the exit code.
- **It does not treat a clean run as evidence.** A run with no failures cannot
  confirm a prediction, so it is recorded with a rate of zero and says so.

### Options

| Flag | Default | Description |
|---|---|---|
| `--head-sha <sha>` | most recent prediction | Reconcile the prediction made at this commit |
| `--json` | off | Print the reconciliation as JSON |

## `variant workspace check`

A CI gate for monorepos: compares what each package actually imports against what its `package.json` declares, and flags three kinds of drift.

```bash
variant workspace check
variant workspace check --json
```

Exits with code `1` when any violation is found — wire it into CI the same way you would `pr check`.

### Violation kinds

| Kind | What it catches |
|---|---|
| `undeclared-workspace-dep` | Package A imports sibling package B by name but doesn't list B in `dependencies`/`devDependencies`/`peerDependencies` — works today only because pnpm/npm hoisting happens to make B resolvable |
| `undeclared-external-dep` | A file imports a third-party package that neither its own manifest nor the workspace root declares |
| `cross-package-relative-import` | A file reaches into a sibling package via a relative path (`../../other-pkg/src/internal.js`) instead of its declared entry point — flagged even when the dependency *is* declared, because it bypasses the package's public API boundary |

Classification is per raw import specifier, so a file that imports a sibling both by name and via a relative path gets both findings. Node builtins (with or without the `node:` prefix) and self-imports are always exempt.

### Output

```
Checked 4 packages.

  ✗ @myapp/web imports @myapp/legacy-utils but does not declare it
      src/hooks/useLegacy.ts
  ✗ @myapp/checkout reaches into @myapp/ui via a relative import (bypasses its public entry)
      src/CheckoutForm.tsx
      src/OrderSummary.tsx

2 violations found.
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--json` | off | Print `{ packagesChecked, violations }` as JSON, still exiting 1 on violations |

Requires workspace mode: a `pnpm-workspace.yaml` or `package.json` `workspaces` field must be discoverable. See [monorepo.md](./monorepo.md) for setup. With no workspace packages found, the command prints a message and exits 0 without checking anything.

## Limitations

Both commands trace imports statically from source text — there is no module bundler or Node resolution algorithm involved. That keeps them fast and dependency-free, but it means a few classes of real edges are invisible to the graph. Treat both commands as *narrowing* signals, not proof:

- **`tsconfig.json` path aliases are not resolved.** Imports like `import { x } from "@/lib/x"` or `#internal/foo` that rely on a `paths` remap in `tsconfig.json` are reported as `unresolved` rather than followed. This lowers confidence scores and, for `workspace check`, can hide a real cross-package edge (or misclassify a legitimate aliased import as an "external" package). If your codebase leans on path aliases, expect wider blast radii and lower confidence than a fully-resolved graph would give — a change behind an alias-only edge won't propagate to its actual importers, and `impact`'s test selection can undercount.
- **Package `exports`-field mapping is best-effort, not a real resolver.** Resolving a bare import of a sibling workspace package (`import { x } from "@org/utils"`) does not read the target's `package.json` `exports` map. It guesses at conventional entry points (`src/index.*`, `index.*`, and the same two under the requested subpath) and takes the first one that exists as an indexed file. A package with a non-conventional `exports` map (e.g. mapping `.` to `dist/esm/index.js`, or using conditional exports) will fail to resolve, landing the import in `unresolved` instead of pointing at the right file.
- **Static import closures miss fixtures, snapshots, and non-TS assets.** `impact`'s test selection is built by forward-BFS over each test file's *statically resolvable* TypeScript imports. A test that reaches its dependencies through a fixture directory, a JSON/YAML snapshot, a dynamically-constructed path, or any non-`.ts`/`.tsx` asset has a blind spot in its closure — the command lowers the confidence score and adds a note ("N selected test file(s) have unresolved imports in their closure — fixtures or assets may be missed") rather than silently trusting an incomplete closure, but it cannot recover the missing edges.
- **Dynamic `import()` calls are unknowable.** Both the differ and blast-radius treat a dynamic import edge as "names unknowable": the change is assumed to propagate (over-including rather than silently missing it) and a note is emitted, but which specific exports are used can't be determined the way a static named import can.
- **Non-TS changes are `unanalyzed`, not `non-impacting`.** A changed `.json`, `.css`, or other non-TypeScript file always contributes a seed to the blast radius (never silently skipped) because the differ has no surface to compare — this is deliberately conservative and can widen the run set beyond what's strictly needed.

Given these gaps, `variant impact` never gates test execution on its own — it logs every prediction to `.variant/history/impact.jsonl` for shadow-mode validation, and the printed guidance is explicit that you should still run the full suite. Treat a low `confidence` score, or any note mentioning unresolved imports or dynamic imports, as a signal to widen your own manual test selection rather than trusting the narrow list.

## See also

- [PR commands](./pr-commands.md) — `pr check` uses the same signature differ that seeds `impact`'s blast radius
- [Monorepo setup](./monorepo.md) — workspace discovery, `--affected`, cascade scoping
- [Troubleshooting](./troubleshooting.md) — common config and detection issues
