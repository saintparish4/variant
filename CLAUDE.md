# Project Instructions

A general guide for working in a codebase. Fill in **Stack** and **Commands** per project. The rest applies unless the project explicitly overrides it.

## Project status and naming

- **The project is `variant`; the npm package is `@blzsky/variant`.** The unscoped name was unobtainable: `variant` and `variant-ts` are taken, and npm's typosquat filter rejects close unscoped alternatives (`vrnt`, `variantjs` were both 403'd). Scoped names skip that filter, so `@blzsky/` is load-bearing, not decoration. Everything a user reads or types is `variant` — bin, `variant.config.ts`, `.variant/`, `VARIANT_*`, `VariantConfig`/`VariantError`. `@blzsky/variant` appears only where a package is addressed: `package.json` `name`, `import … from "@blzsky/variant"`, `npm install -D @blzsky/variant`, `npx @blzsky/variant <cmd>`. Never write `npx variant` — that fetches the unrelated package.
- **Name history:** `antiscaler` (published 0.1.0–1.1.1) → `link` (never published; the npm name is taken, and a global `link` bin shadows the `/usr/bin/link` coreutil) → `linkctl` (published 2.0.0) → `variant`, published as `@blzsky/variant` from 0.1.0. The version reset with the package name. Old names in CHANGELOG entries are history; do not rewrite them. Because both series reuse the version numbers 0.1.0–1.1.1, the pre-rename entries live in `CHANGELOG-archive.md` with their bare `vx.y.z` tags, and the current series is tagged `variant@x.y.z`.
- **Breaking changes are acceptable.** The package is live on npm with no known users, and `0.x` says so. Do not add compatibility shims, deprecation periods, or migration code, but do record every breaking change in CHANGELOG.
- **The product is the change-intelligence half.** `impact`, `diff`, `pr check`, `pr report`, `workspace check`, `doctor` and `env` are what variant is for; `build`, `run`, the local content cache and `insight` are frozen — they carry the cache-key invariants and dogfood the repo, but get no new work. The tracer, trace commands, `pr replay`, `--scope`, `performance.*`, the remote cache and `dev` were deleted in 0.2.0; do not reintroduce them.
- **Status and plan** live in `base/current-state.md` and `base/next-steps.md`. `base/` is gitignored, so they exist only in the local checkout.

## Stack

`variant` — AST-level change intelligence for TypeScript monorepos (`diff`, `impact`, `pr check`, `workspace check`) on top of an adaptive dev orchestration CLI (task DAG, content caching, runtime detection).

- **Language**: TypeScript, ESM only (`"type": "module"`). Node ≥ 20, pnpm ≥ 10.
- **Build**: tsup — two entry points: `src/index.ts` (library) and `src/cli/index.ts` (`variant` binary).
- **CLI**: Commander.js.
- **Key libraries**: zod (config schema and defaults), jiti (loads `variant.config.ts` with no build step), execa (process execution), fast-glob (input hashing), ts-morph (semantic change analysis), picocolors, string-argv.
- **Tooling**: Biome (format + lint + import organization), Vitest with v8 coverage, TypeScript (`tsc --noEmit`).

## Architecture

Layered, with dependencies pointing one way: `cli → core → adapters`. Interfaces (ports) are owned by `core`; adapters implement them and import nothing from `core` except types.

- `src/cli/` — Commander wiring, option parsing, terminal rendering. The user-facing surface.
- `src/core/` — orchestration logic, grouped by capability (`cache`, `config`, `detection`, `doctor`, `execution`, `graph`, `history`, `impact`, `insight`, `plugins`, `pr`, `progress`, `provenance`, `scaffold`, `scope`, `semantic`, `vcs`) rather than by technical kind. No `utils/`, `helpers/`, or `services/` buckets. Despite its name, `core/progress/reporter.ts` is a port (a bare `TaskEvent` interface); everything that draws lives in `cli/visuals/` (printer, progress, spinners, prompts, color) and `cli/render/` (command output, errors).
- `src/adapters/` — the outside world: `pm/` (npm/pnpm/yarn command builders), `runtimes/` (Node/Bun/Deno detection), `frameworks/` (Next.js/Vite/generic, each wrapped as a plugin via `wrapFrameworkAsPlugin`). One file per implementation.
- `src/types/` — contracts shared across layers.

Rules:

- Business logic must not live in command handlers. A command parses options, calls `createContext()`, delegates to `core`, and renders the result. A command file growing branches and conditionals means the logic belongs in `core`.
- `core` must not print or exit. It reports through the progress/reporter interface and throws typed errors from `core/errors.ts` (`VariantError` subclasses with a machine-readable `.code` and a user-facing `.hint`); only the CLI top level catches `VariantError` → exit 1, unexpected errors → exit 2.
- Side effects live at the edges and arrive through injectable interfaces — `runTasksWithDeps` takes a `TaskExecutor`, defaulting to the real one. This is what keeps the suite unit-heavy: unit tests never shell out.
- Config is loaded once, at one wiring point (`cli/context.ts:createContext()`), which also detects PM/runtime/framework, builds the task DAG, and computes the git-diff `packageScopes`/`affectedPackages` pre-filter. Modules receive what they need instead of re-reading config themselves. Commands that never run a task and never render provenance pass `{ scope: false }` to skip the git work — `env`, `check`, `insight` do. Anything consuming `packageScopes`, or rendering why a task ran, must leave it on.
- **Deferred imports are a measured optimization, not a style.** `src/cli/index.ts` registers each command with a dynamic `import()` inside its `action()`; `core/vcs/git.ts` and `core/execution/executor.ts` defer execa; `core/graph/package-graph.ts` defers fast-glob; `adapters/pm/*.ts` defer execa; `core/semantic/{differ,symbol-graph}.ts` defer ts-morph. All of these sit on the static import path of `cli/context.ts`, which every command loads, and each was worth tens of milliseconds of startup. That is the bar: profile first (`node --cpu-prof dist/cli.js <cmd>`), and add one only when a real dependency is being paid for by commands that never use it. Everywhere else, prefer top-level imports. Startup is a CI gate: `benchmark.yml` fails when the `--help` median exceeds 200 ms.
- Color is resolved once: `cli/visuals/color.ts:resolveColorChoice()` → `writeGlobalColorChoice()`, with precedence `--color` → `--no-color` → `NO_COLOR` → `FORCE_COLOR`/`CLICOLOR_FORCE` → TTY. Renderers call `getColors()` and write through `getPrinter()` (`render/writer.ts`) so `-q`/`-qq`/`-v` gate every line; only `color.ts` reads color env vars. A second color or output path is the bug this design prevents.
- A new capability is a new directory under `core/` plus a thin command — not another branch inside an existing module.
- Bounded concurrency lives in `core/execution/concurrency.ts` (`mapLimit`, order-preserving). Reuse it rather than writing a second worker pool.

### Core pipeline

The request path most commands follow: `createContext()` → `core/graph` builds the `TaskGraph` (Kahn's algorithm, cycle detection) → `core/execution:runTasksWithDeps()` resolves DAG levels and runs each task (concurrency-limited, or via the event-driven `scheduler.ts` when `useScheduler` is set) → `core/cache` hashes inputs and reads/writes `.variant/cache/cache.json`, narrowed by `core/cache/git-diff.ts` to changed packages. `core/plugins` fans out `onDetect`/`onHash`/`onBeforeExecute`/`onAfterExecute` hooks to registered `BuildPlugin`s (framework adapters are wrapped as plugins). `core/semantic` (ts-morph-based signature/body diffing, symbol graph, blast-radius, test-impact selection) drives the change-intelligence features (`variant diff`, `pr check`, `variant impact`); predictions are logged to `.variant/history/impact.jsonl` for shadow-mode validation before test skipping is ever enabled.

### Invariants worth knowing before you "optimize" them

- **Constructing a ts-morph `Project` dominates the semantic path.** Hoist one classifier with `createClassifier()` and reuse it across files; never call `classifyChange` in a loop. `symbol-graph.ts` follows the same one-Project-per-build shape, and removes each file after indexing it: with other files left in the Project an inferred export type resolves through them, and an entry reused by content hash would stop matching a cold build.
- **Input hashing is the cache key, so it is correctness-critical.** Each file is hashed to its own digest and the digests are combined in path order. Digests are deliberately *not* shared across the tasks of a run: a path-keyed cache would have to prove nothing rewrote the file since the last task hashed it, and stat (mtime + size) cannot — a same-length rewrite inside one mtime tick is invisible, and serving the stale digest hands a later task a cache key it should have missed. Changing how digests combine changes every cache key; treat that as a deliberate, noted full invalidation.
- **Bump `SYMBOL_GRAPH_VERSION` whenever extraction changes what an index records.** `symbols.json` reuses each file's entry by content hash, so without a bump an unchanged file keeps the edges an older extractor produced and silently misses the new kind.
- **`cache.json` is written to a temp file and renamed over the target.** Rename is atomic within a filesystem, so an interrupted run leaves the previous cache intact instead of truncated JSON. `writeCacheSync` is the process-exit safety net and needs this most — do not turn either back into a direct write.
- **`vcs/git.ts` reads many blobs with one `git cat-file --batch`,** falling back to a `git show` per file if the batch cannot be parsed. The two readers must return identical strings, which is why the batch strips the final newline that execa strips for it.
- **Git pathspecs are POSIX on every OS.** Pass paths to `git show <ref>:<path>` and `cat-file` through `toPosix()`. A backslash path from `path.relative` on Windows fails as a pathspec, and once was silently swallowed as "new file", so every export classified as breaking.
- **Test skipping stays off until it is measured.** `impact` is report-only. Every prediction is appended to `.variant/history/impact.jsonl`, and skipping may be enabled only after a false-skip rate, measured by reconciling predictions against real test results, is acceptable. The printed confidence is a graph-resolution score, not a safety number; never present it as one.
- **Change analysis fails wide, never narrow.** Whatever the semantic pipeline cannot prove widens the result or lowers confidence:
  - Non-TS changes are `unanalyzed` seeds, not `non-impacting`, and reach every file whose unresolved imports name them (`importersOfUnindexed`).
  - Dynamic `import()` propagates as "names unknowable". A computed specifier links to everything under its literal prefix; one with no prefix is noted on every run.
  - A file that does not parse is `breaking` and ungated, as is a changed `export *`: neither has names worth gating on.
  - Unresolved specifiers lower confidence and emit a note.
  - Changes to `package.json`, lockfiles, `tsconfig*.json`, or test/build runner configs select every test.

  A change that turns an unknown into a silent skip is a correctness bug, whatever it saves.
- **Security boundaries:**
  - Task `inputs` reject absolute patterns and any `..` segment (`cache/hashing.ts:assertSafePattern`).
  - Commands run through execa with a string-argv array, never a shell.
  - Git invocations put `--` before paths, and `vcs/git.ts` answers a ref starting with `-` without running git, so neither a path nor a ref can become an option.
  - The config schema has no credential fields.

## Code Style

- Follow the project's formatter and existing conventions. Do not invent a parallel style.
- Prefer named exports.
- Avoid `any`, non-null assertions (`!`), and other untyped escape hatches; Biome blocks the first two. A `biome-ignore` needs a reason and should be rare.
- Semicolons, quotes, and similar punctuation follow the language and the formatter. This project uses tabs and double quotes for TS/JS, 2-space for JSON (Biome-enforced).
- Use the `node:` protocol for Node built-ins, `import type` for type-only imports, and `import * as z from "zod"` (never `import { z }`) — all Biome-enforced.
- Use `Uint8Array` instead of `Buffer` (Biome blocks `Buffer` in `src/`).
- `tsconfig.json` enables `exactOptionalPropertyTypes`: pass optional fields with a conditional spread (`...(x !== undefined && { x })`), never `x: undefined`.
- `noPropertyAccessFromIndexSignature` is on, so index-signature types use bracket access. Biome's `useLiteralKeys` is disabled because it conflicts with this; do not re-enable it. `noUncheckedIndexedAccess` is on too.
- Prefer optional chaining/nullish coalescing and early returns over deep nesting; combine conditions in one `if` rather than nesting them.
- Avoid shortening variable names (`packageScopes`, not `pkgScopes`).

## Testing

Three tiers, each answering a different question. Write the test at the cheapest tier that can answer yours.

| Tier | Tests | Lives in | Runs against |
|------|-------|----------|--------------|
| Unit | Isolated behavior — one module, collaborators substituted | `src/**/__tests__/*.test.ts`, beside its source | Source |
| Integration | Boundaries — real modules meeting each other, or a real edge (filesystem, git, config loading) | `src/__tests__/integration/*.integration.test.ts` | Source |
| E2E | User workflows — the shipped binary doing what someone asked it to do | `src/__tests__/e2e/*.e2e.test.ts` | Built `dist/` |

- **Unit tests isolate.** Inject at the seams the architecture already provides — `runTasksWithDeps` takes a `TaskExecutor`; pass a mock. Never shell out, never touch the network, never depend on the surrounding repo's git state. A test that needs a fixture workspace to say anything true is not a unit test.
- **Integration tests exercise boundaries.** The contract between two real collaborators: does the config loader hand the planner something the planner accepts, does the cache store survive a round-trip through a real filesystem, does `git-diff.ts` read a real repo correctly. Assert on the seam — not on terminal output, which belongs to E2E.
- **E2E tests describe workflows in the user's words.** "A fresh build runs every task in dependency order." "A second run hits the cache." "Changing `utils` rebuilds `web` but skips `docs`." They spawn `dist/cli.js` against a fixture workspace and assert on exit codes and stdout, so they need `pnpm build` first. Keep this tier small — it is the slowest and most brittle; add to it only for a workflow a user would notice breaking.
- Fixture workspaces are shared across tiers at `src/__tests__/fixtures/`.
- New business logic requires tests. A bug fix requires a test that fails before it.
- Name tests for the behavior they document (`test_cache_hit`, `test_cache_miss`, `test_incremental_invalidation`), not for the function they call.
- Use the project's test runner — Vitest projects `unit`, `integration`, `e2e`. Do not introduce another without justification.
- This repo skews heavily unit-first by design; dependency injection is what makes that possible, so reach for a slower tier only when the question genuinely lives at a boundary or in a workflow.
- Coverage is opt-in, not automatic: it runs only under `--coverage` (`pnpm test:all` and the CI coverage job), so `pnpm test:run` and single-file runs stay fast and do not trip global thresholds. CI enforces 70% lines/statements/functions, 60% branches.
- Read and copy the style of similar existing tests when adding new cases.

## Commands

```bash
pnpm build             # compile to dist/ via tsup
pnpm clean             # delete dist/
pnpm test              # vitest in watch mode
pnpm test:run          # vitest single-run
pnpm test:integration  # integration project only (boundaries)
pnpm test:e2e          # e2e project only — requires pnpm build first
pnpm test:all          # all tests + coverage
pnpm format            # biome format --write .
pnpm format:check      # biome format (read-only)
pnpm lint              # biome check . (static analysis, read-only)
pnpm typecheck         # tsc --noEmit
pnpm check             # biome check --write (local autofix: format + lint + organize imports)
pnpm bench             # benchmark suite (--quick via pnpm bench:quick)
pnpm accuracy          # commit replay: shadow mode over pinned repos' history (accuracy/README.md)

# Run a single test file
pnpm vitest run src/core/graph/__tests__/dag.test.ts

# Test the built CLI
node dist/cli.js --help
```

See `CONTRIBUTORS.md` for full dev-setup steps. Prefer running a single test file (as above) over the full suite while iterating. Never run a blanket `pnpm update` — bump one package at a time so lockfile diffs stay reviewable. Cross-platform correctness is CI's job (`ubuntu`/`windows`/`macos` × Node 20/22/24 in `.github/workflows/ci.yml`), not a local cross-compile step — prefer `node:path` helpers over manual string splitting so the matrix actually catches regressions.

All PRs must pass `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`. The default branch is `master`, which is expected to be lint-clean — a warning there is from your change, not pre-existing. Commits follow conventional commits: `<type>: <subject>`, imperative mood, ≤ 72 chars, no trailing period.

The `.husky/pre-commit` hook gates every commit through `pnpm format:check` → `pnpm lint` → `pnpm typecheck` → `pnpm test:run`, in that order; a failure at any step blocks the commit before the next step runs.

| Type | Purpose |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `perf` | Performance improvement |
| `refactor` | Code refactoring |
| `test` | Test additions/changes |
| `docs` | Documentation |
| `chore` | Build/tooling changes |
| `types` | Type definition updates |
| `ci` | CI/CD changes |

## Rules

- Do not introduce dependencies without justification.
- Do not expose secrets.
- Make the code obvious: good names, clear control flow, small functions, strong types, clear abstractions, tests.
- Use tests to document behavior (`test_cache_hit`, `test_cache_miss`, `test_incremental_invalidation`).
- Use documentation for system-level concepts. User-facing guides live in `docs/` (`getting-started`, `impact-and-workspace`, `pr-commands`, `monorepo`, `config-reference`, `troubleshooting`); architectural rules live here.

### Comments

Do not narrate the implementation. Do not add comments that restate what the code does. Do not generate comments for every function, variable, loop, or block. Do not add comments solely to make generated code appear documented. When reviewing AI-generated code, delete unnecessary comments rather than keeping them because they look helpful.

Comments must explain **why**, not **what**, unless the what is genuinely difficult to understand.

Only add comments when they explain:

- Why a decision was made, or why something is implemented a certain way
- Non-obvious constraints, invariants, or design decisions
- Algorithmic reasoning
- Performance considerations
- Safety requirements
- External or system constraints
- Compatibility requirements or workarounds
- Important architectural decisions
- Behavior that would otherwise be surprising
