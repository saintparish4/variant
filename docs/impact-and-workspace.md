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
| `internal` | Body-only change to an exported symbol — does not propagate to importers in the blast radius, but every test that imports the file (directly or transitively) is still selected |
| `breaking` | An exported symbol's signature changed, or an export was added or removed — propagates to dependents |
| `unanalyzed` | Not a TypeScript source (e.g. `.css`, `.json`, `.js`, `.d.ts`) — the differ has nothing to compare, so the change reaches every TypeScript file whose imports name it (`import "./button.css"`) |

Propagation past the first hop is structural (any dependent of a dependent is included), because a dependent's own inferred surface may change in ways single-file analysis can't see. The first hop is gated per symbol: a dependent that only imports names your change didn't touch is left out of the blast radius. A changed `export *`, and a file that does not parse (either version), are not gated: their names cannot be trusted, so every importer is reached. A file that does not parse is also classified `breaking`, whatever the comparison said.

Test selection does not use the per-symbol gate. Every test that imports a changed file, directly or through other files, is selected.

### Output

```
Base ref: main
Workspace: 4 packages

You changed 3 files.
  breaking       src/api/checkout.ts  (createOrder)
  internal       src/hooks/useCart.ts
  non-impacting  src/utils/format.ts

Impact: 12 files, 2 packages (@myapp/web, @myapp/checkout)

Run:   8 test files
Skip:  47 test files (of 55 total)

Verdict:    build required
Confidence: medium (82%)  (report-only — run the full suite; skipping unlocks after shadow-mode validation)

Notes:
  - src/lib/legacy.ts: dynamic import of src/auth.ts — names unknowable
```

`Workspace:` says how many workspace packages were discovered. A bare import of a package discovery missed counts as a third-party dependency, so "no workspace packages found" in a monorepo explains a prediction that is too narrow; see [Monorepo setup](./monorepo.md).

`Confidence:` is a bucket first — `high` at 90% and up, `medium` from 70%, `low` below — then the score. The score starts at 100% and drops 10 points per note, with a floor of 30%: it counts what the analysis could not resolve, not how safe a skip would be.

When a changed file that variant cannot analyze reaches no test, an `Unreached:` line names it. Prose (`.md`, `.txt`, `.rst`, `.adoc`) is left out of that line. No test is selected for such a file, and nothing in the graph says which tests use it, so run those yourself.

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
| `--json` | off | Print the full report (`radius` + `tests`) as JSON instead of the human summary. [Shape](./api.md#impact---json) |

### Select-all triggers

Certain changed paths invalidate the whole test suite regardless of import closure, because narrowing would be unsafe:

- `package.json`, lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`)
- `tsconfig*.json`
- Test/build runner configs (`vitest.config.*`, `vitest.workspace.*`, `vitest.projects.*`, `jest.config.*`, `playwright.config.*`, `vite.config.*`, `babel.config.*`, `.babelrc*`)
- Test setup files with a conventional name (`vitest.setup.*`, `jest.setup.*`, `setupTests.*`, `global-setup.*`, `global-teardown.*`, `test/setup.*`). A runner loads them before every test, but no test imports them.

These match by path, whatever the file's classification: a `vitest.config.ts` edit is `breaking` or `internal` code to the differ, and still selects everything.

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

A workspace that runs each package's tests separately has one report per
package. Pass them all: `variant impact verify packages/*/report.json` reads
them as one run.

```
Prediction: 2026-09-17T22:38:46.120Z (2db3ee3f2de6d9344a099915a0fa229536216d03)
Matched by: head SHA

Predicted:  1 of 2 test files
Ran:        2 test files, 1 of them predicted
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

The **false-skip rate** is false skips divided by failed test files: of the
failures that happened, how many the prediction would have missed. It is not
divided by the number of skipped tests. Most skipped tests pass, so that
denominator makes any selector look nearly perfect. Two consequences are
deliberate:

- **A flaky failure outside the predicted set counts as a false skip.** variant
  cannot tell a flake from a real miss, so it counts against the prediction.
  The rate can only overstate the risk, never hide it.
- **The unit is a test file,** because that is what `impact` selects and what
  Jest and Vitest reports name.

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
| `--head-sha <sha>` | most recent prediction | Reconcile the prediction made at this commit. Pass the full SHA: `"$(git rev-parse HEAD)"` |
| `--json` | off | Print the reconciliation as JSON. [Shape](./api.md#impact-verify---json) |

[`examples/github-actions/impact-shadow.yml`](../examples/github-actions/impact-shadow.yml) runs predict → full suite → reconcile in CI and keeps the history across runs.

## `variant workspace check`

A CI gate for monorepos: compares what each package actually imports against what its `package.json` declares, and flags three kinds of drift.

![Running `variant workspace check`: @acme/shop imports @acme/blog but does not declare it, 1 violation found](./assets/workspace-check.gif)

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

An import that a `tsconfig.json` `paths` alias covers (`@/lib/price`) names a file in the workspace, not a package, and is judged by where that file lives. Inside the importing package there is nothing to declare. When the alias reaches into a sibling package the importer does not declare, it is an `undeclared-workspace-dep`, the same as importing that sibling by name.

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
| `--json` | off | Print `{ packagesChecked, violations }` as JSON, still exiting 1 on violations. [Shape](./api.md#workspace-check---json) |

Packages are discovered from `pnpm-workspace.yaml`, else the `package.json` `workspaces` field, else the directories `packages/*`, `apps/*` and `services/*`; no `variant.config.ts` is needed. Only directories whose `package.json` has a `name` count. With no workspace packages found, the command prints a message and exits 0 without checking anything.

## Limitations

Both commands trace imports statically from source text — there is no module bundler or Node resolution algorithm involved. That keeps them fast and dependency-free, but it means a few classes of real edges are invisible to the graph. Treat both commands as *narrowing* signals, not proof:

- **Path aliases are read from every `tsconfig.json`, and from no other config file.** `compilerOptions.paths` is read through the TypeScript compiler's own config parser, so JSONC, `extends` chains and `baseUrl` behave as `tsc` does, and an alias-only edge (`import { x } from "@/lib/x"`) propagates like any other import. Each `tsconfig.json` applies to the files under its directory, and the nearest one wins, so `@/*` can mean a different directory in every package. Aliases declared only in a differently named file (`tsconfig.app.json`, a `tsconfig.base.json` that no `tsconfig.json` extends) are not read. An alias that matches a pattern but names no indexed file is reported as `unresolved` rather than silently counted as an external package.
- **Package `exports` maps are read, but the source they name is inferred.** Resolving a bare import of a sibling workspace package (`import { x } from "@org/utils"`) consults the target's `package.json` `exports`, including conditional exports, fallback arrays and `*` subpath patterns. The catch is that `exports` names *published* entry points, which are usually build output that does not exist in a source checkout: a target of `./dist/entry.js` is therefore also probed as `src/entry`, `lib/entry`, `source/entry` and `entry`. A package whose sources sit somewhere else entirely still falls through to the conventional `src/index.*` guesses, and then to `unresolved`. This layer is additive — it can find edges the guesses miss, never lose ones they find.
- **Imported assets reach their importers; files read at runtime do not.** A changed stylesheet, JSON file or other non-TypeScript file reaches every TypeScript file whose imports name it — relative, workspace-package and alias specifiers alike — and through them the tests. What stays invisible is a file a test reads at runtime rather than imports: a fixture directory, a snapshot, `fs.readFile("data.json")`. A changed file that reaches no test is listed under `Unreached:`, and a selected test whose closure has unresolved imports adds a note ("N selected test file(s) have unresolved imports in their closure — fixtures or assets may be missed").
- **`node_modules` and `dist` are never indexed, at any depth.** A source directory that happens to be named `dist` is left out with them. A changed TypeScript file there is `unanalyzed`: it selects the tests of the files that import it, and otherwise appears under `Unreached:`.
- **Only the directory variant runs in is indexed.** Run it where the project's `package.json` and `tsconfig.json` are, which need not be the repository root. A file changed elsewhere in the repository is shown as `../…` and is `unanalyzed`: it selects the tests of the files that import it by relative path, and otherwise appears under `Unreached:`. A sibling workspace package imported by name is not followed from inside one package, so its changed files land there too; run from the workspace root to follow them.
- **JavaScript is not indexed.** Only TypeScript sources and tests (`.ts`, `.tsx`, `.mts`, `.cts`) are. A changed `.js` file reaches the TypeScript files that import it, but a `.js` file's own imports are not followed, and `.js` tests are not counted: a repository whose tests are all JavaScript stops with `NO_TEST_FILES` rather than predicting "0 of 0".
- **Computed specifiers are followed as far as their literal start.** `` import(`./locales/${lang}.js`) `` and `require("./plugins/" + name)` link the loader to every indexed file under `./locales/` or `./plugins/` (and to changed non-TypeScript files there), whole workspace packages when the prefix names one, and `tsconfig` alias targets. A specifier with no literal start, such as `import(name)`, could load anything: it is noted on every run, and a change reached only that way selects no tests.
- **Dynamic `import()` names are unknowable.** A dynamic import edge is treated as using every export: the change propagates (over-including rather than missing it) and a note is emitted. Literal `require("./x")` and `import x = require("./x")` are ordinary edges that take every name.
- **Edges that exist only at runtime are invisible.** A dependency injection container resolving a class by token, a plugin registry keyed by string, and `eval` never appear as imports. A test that reaches code only through one of these is not selected when that code changes, and nothing in the output says so. This is the largest blind spot and the main reason `impact` is report-only.
- **Workspace discovery can miss a package.** A bare import of a package variant did not discover is treated as a third-party dependency. `impact` notes a dependency declared with a local protocol (`workspace:*`, `link:`, `file:`, `portal:`) that no discovered package provides, and bare imports that neither a workspace package nor the importing file's nearest `package.json` (or the root) accounts for — which is also how an alias from a per-package `tsconfig.json` shows up.
- **Service boundaries end the graph.** An end-to-end test that drives a running server over HTTP, or a test of one service that depends on another service's behavior, imports none of the code it exercises. variant sees the test files and the source separately, never the network call between them.
- **Setup files with an unconventional name are missed.** Tests never import a `setupFiles` or `globalSetup` module. The conventional names are [select-all triggers](#select-all-triggers), but a setup file named anything else selects no tests when it changes, and confidence stays high because every import did resolve. variant does not read the runner config to learn the names. Run the full suite for such a change.
- **Shared state is not an import.** Test ordering, and state one test leaves behind for another, are outside the closure.
- **Type-only changes are not narrowed.** Changing an interface or type alias selects every test that imports the file, the same as a runtime change, even though no runtime behavior changed. This errs wide.
- **Non-TS changes are `unanalyzed`, not `non-impacting`.** A changed `.json`, `.css`, or other non-TypeScript file is always a seed of the blast radius (never silently skipped), because the differ has no surface to compare. This errs wide.

Given these gaps, `variant impact` never gates test execution on its own — it logs every prediction to `.variant/history/impact.jsonl` for shadow-mode validation, and the printed guidance is explicit that you should still run the full suite. Treat a low `confidence` score, or any note mentioning unresolved imports or dynamic imports, as a signal to widen your own manual test selection rather than trusting the narrow list.

## See also

- [PR commands](./pr-commands.md) — `pr check` uses the same signature differ that seeds `impact`'s blast radius
- [Monorepo setup](./monorepo.md) — workspace discovery, `--affected`, cascade scoping
- [Troubleshooting](./troubleshooting.md) — common config and detection issues
