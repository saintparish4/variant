# Contributing to variant

This guide is for working **on** variant. Using it in your own project is covered
in [docs/](./docs/getting-started.md). Architecture and code-style rules are in
full in [CLAUDE.md](./CLAUDE.md); this file is the practical version.

## Requirements

| | Version | Notes |
|---|---|---|
| Node | ≥ 20 | Enforced via `engines`; CI tests 20, 22 and 24 on Linux, Windows and macOS |
| pnpm | ≥ 10 | Pinned by `packageManager` |
| git | ≥ 2.28 | `diff`, `impact` and `pr *` need a repository to compare against, and the tests create them with `git init -b` |

Optional:

- **[hyperfine](https://github.com/sharkdp/hyperfine)** makes `pnpm bench`
  timings more precise; without it the harness uses a built-in timer.
- **[agg](https://github.com/asciinema/agg)** is needed only to regenerate the
  terminal demos in `docs/assets/` (see [Documentation](#documentation)).

## Dev setup

```bash
git clone https://github.com/saintparish4/variant.git
cd variant
pnpm install
pnpm build               # required before the CLI or E2E tests can run
node dist/cli.js --help  # smoke test
```

The quality gate runs in the same order as CI and the pre-commit hook:

```bash
pnpm format:check      # biome format (read-only)
pnpm lint              # biome check . (read-only)
pnpm typecheck         # tsc --noEmit
pnpm test:run          # every test tier, once
```

Other commands:

```bash
pnpm format            # biome format --write .
pnpm check             # biome check --write: format + lint + organize imports
pnpm build             # compile both entry points to dist/ via tsup
pnpm clean             # delete dist/
pnpm bench             # benchmark harness (pnpm bench:quick for a fast pass)
```

The default branch is `master`, and it is expected to be lint-clean: if
`pnpm format:check`, `pnpm lint` or `pnpm typecheck` is red, your change caused
it.

There is no watch build. The loop is `pnpm build && node dist/cli.js <command>`,
run against a scratch project, `examples/monorepo`, or one of the fixture
workspaces in `src/__tests__/fixtures/`.

## Architecture overview

Layered, with dependencies pointing one way: `cli → core → adapters`. Ports are
owned by `core`; adapters implement them and import nothing from `core` except
types.

```
src/
├── index.ts              # The public API: defineConfig and the config types
├── cli/
│   ├── index.ts          # Program definition, lazy command registration, exit codes
│   ├── context.ts        # createContext(): config, detection, task DAG, git scoping
│   ├── execute.ts        # Shared run path for build/run (progress + insights)
│   ├── parse-opts.ts     # Shared option parsing (--concurrency)
│   ├── commands/         # One file per command: parse, delegate, render
│   ├── render/           # All command output and errors; writes through the Printer
│   └── visuals/          # Printer, colors, progress, spinners, ANSI primitives
│
├── core/
│   ├── cache/            # hashing.ts (input hashes), store.ts (cache.json), git-diff.ts
│   ├── config/           # schema.ts (zod, with defaults), loader.ts (jiti)
│   ├── detection/        # Package manager, runtime and framework detection
│   ├── doctor/           # The checks behind `variant doctor`
│   ├── execution/        # executor.ts (execa), runner.ts (level-parallel DAG),
│   │                     # scheduler.ts (event-driven), concurrency.ts (mapLimit)
│   ├── graph/
│   │   ├── dag.ts            # TaskGraph: addTask, addDependency, toLevels
│   │   ├── planner.ts        # buildGraph(): config -> TaskGraph
│   │   ├── validation.ts     # validateTaskGraph(), behind `variant check`
│   │   ├── package-graph.ts  # Workspace discovery and cross-package tasks
│   │   ├── import-graph.ts   # File-level import graph over the symbol index
│   │   ├── package-exports.ts  # Resolves package `exports` maps
│   │   ├── tsconfig-paths.ts   # Resolves tsconfig `paths` aliases
│   │   ├── workspace-check.ts  # Pure declared-vs-imported dependency audit
│   │   └── workspace-audit.ts  # Gathers manifests + symbol graph, runs the audit
│   ├── history/          # impact-log.ts: the .variant/history JSONL files
│   ├── impact/           # predict.ts (`impact`), verify.ts (`impact verify`)
│   ├── insight/          # computeInsights(): stats from results + cache
│   ├── plugins/          # BuildPlugin interface and the registry that fans out hooks
│   ├── pr/               # check.ts (classify a PR), report.ts (JSON / markdown)
│   ├── progress/         # reporter.ts: the progress port; every renderer is in cli/
│   ├── provenance/       # Why each task was selected to run
│   ├── scaffold/         # The template behind `variant init --tasks`
│   ├── scope/            # Package sets -> runner predicates
│   ├── semantic/
│   │   ├── surface.ts        # Collects a file's exported surface
│   │   ├── differ.ts         # Classifies a change via ts-morph
│   │   ├── file-change.ts    # Classifies a file against a git ref
│   │   ├── symbol-graph.ts   # The persisted, incremental symbol index
│   │   ├── blast-radius.ts   # Reverse-graph traversal from changed files
│   │   ├── test-impact.ts    # Which tests a change requires
│   │   └── verdict.ts        # The build verdict shared by `pr check` and `impact`
│   ├── setup/            # `variant init`: discover.ts, plan.ts (the changes, as
│   │                     # values), apply.ts, and the config and workflow edits
│   ├── vcs/              # git.ts: the git porcelain every capability reads through;
│   │                     # change-base.ts: the base and pushed commits, detected
│   └── errors.ts         # VariantError and its subclasses, each with a .code
│
├── reporters/            # The surface inside a user's test run
│   ├── shadow.ts         # Predict beside the run, reconcile after it; no runner types
│   └── vitest.ts         # `@blzsky/variant/vitest`: Vitest hooks -> shadow.ts
│
├── adapters/
│   ├── types.ts          # Adapter interfaces
│   ├── pm/               # npm.ts, yarn.ts, pnpm.ts
│   ├── runtimes/         # node.ts, bun.ts, deno.ts
│   └── frameworks/       # next.ts, vite.ts, generic.ts, plugin.ts
│
└── types/                # Contracts shared across layers
```

`tsup` builds three entry points: `dist/index.js` (the library), `dist/cli.js`
(the `variant` binary) and `dist/vitest.js` (the Vitest adapter, also built as
`dist/vitest.cjs` for configs loaded with `require`).

The request path for most commands: `cli/context.ts:createContext()` loads the
config, detects the package manager, runtime and framework, builds the task DAG,
and computes git-diff scoping. Then `core/execution:runTasksWithDeps()` walks
the DAG level by level while `core/cache` hashes inputs against
`.variant/cache/cache.json`.

Along the way `core/provenance` records why each task was selected to run: a
cache miss, affected by the diff, or never cached. The runner attaches that
record to the `VariantError` a failing task throws, and `cli/render/error.ts`
prints it under the failure. It explains *selection*, never *cause*; see
[troubleshooting](./docs/troubleshooting.md) for the output.

### Key design decisions

- **Lazy imports.** `src/cli/index.ts` registers every command with a dynamic
  `import()` inside its `action()`, deferring execa, jiti and fast-glob until a
  command actually runs. That keeps `variant --help` fast, and the benchmark
  job fails if its median startup exceeds 200 ms. It is the one sanctioned
  exception to the project's prefer-top-level-imports rule.
- **DI in the runner.** `runTasksWithDeps` accepts a `TaskExecutor` (defaulting
  to the real `executeTask`), so tests inject a mock and never shell out.
- **Typed errors.** Every expected failure throws a `VariantError` subclass
  with a machine-readable `.code` and, usually, a `.hint`. The CLI top level
  maps them to exit 1; anything else is exit 2. The codes are listed in the
  [CLI reference](./docs/cli-reference.md#exit-codes-and-errors).
- **`core` never prints.** It reports through the progress port and throws
  typed errors; every byte of terminal output is produced in `cli/render/` and
  written through the `Printer`, which is what makes `-q`/`-v` work uniformly.
  `core/progress/reporter.ts` is a *port*, a bare `TaskEvent` interface,
  whatever its name suggests. A `console.log` in `core` is a bug.
- **Color resolves once.** `cli/visuals/color.ts:resolveColorChoice()` applies
  `--color` → `--no-color` → `NO_COLOR` → `FORCE_COLOR`/`CLICOLOR_FORCE` → TTY,
  and renderers call `getColors()`. A second color path is the mistake this
  prevents.

## How to add an adapter

Example: adding support for a new package manager (say, `bun`).

1. Create `src/adapters/pm/bun.ts`:
   ```typescript
   import type { PackageManagerAdapter } from "../types.js";

   export const bunAdapter: PackageManagerAdapter = {
     name: "bun",
     lockfile: "bun.lockb",
     installCommand: "bun install",
     runCommand: (script) => `bun run ${script}`,
   };
   ```

2. Register it in `src/core/detection/packageManager.ts`: add the adapter to
   the detection list. The detector checks for the lockfile and returns the
   first match.

3. Add a test in `src/core/detection/__tests__/packageManager.test.ts`
   verifying that when `bun.lockb` exists, the bun adapter is returned.

## Testing

Three tiers, each answering a different question. Write a test at the cheapest
tier that can answer yours.

| Tier | Tests | Lives in | Runs against |
|------|-------|----------|--------------|
| Unit | Isolated behavior: one module, collaborators substituted | `src/**/__tests__/*.test.ts` | Source |
| Integration | Boundaries: real modules meeting, or a real edge (filesystem, git, config) | `src/__tests__/integration/` | Source |
| E2E | User workflows through the shipped binary | `src/__tests__/e2e/` | Built `dist/` |

```bash
pnpm test              # watch mode
pnpm test:run          # every tier, once
pnpm test:integration  # boundaries only
pnpm test:e2e          # workflows only; run pnpm build first
pnpm test:all          # everything + coverage
pnpm vitest run src/core/graph/__tests__/dag.test.ts   # a single file
```

Fixture workspaces are shared across tiers at `src/__tests__/fixtures/`.
Coverage runs only under `--coverage` (`pnpm test:all` and the CI coverage
job), and CI enforces 70% lines/statements/functions and 60% branches.

- Mock the `TaskExecutor` in runner tests; unit tests never shell out.
- Use `mkdtemp` for tests that need a real filesystem.
- One behavior per `it()` block, named for the behavior it documents.
- A bug fix comes with a test that fails before it.

## Documentation

User-facing documentation lives in [`docs/`](./docs), examples in
[`examples/`](./examples). A change users can observe updates the relevant page
in the same PR, and CLI output quoted in the docs should be pasted from a real
run, not typed.

The GIFs in `docs/assets/` are recorded from real output by
`scripts/record-demos.mjs`. It builds `examples/monorepo` into a throwaway git
repository, runs the built CLI against it, and renders each session with
[agg](https://github.com/asciinema/agg). Commit dates are fixed, so an unchanged
CLI produces identical frames. After changing any output the demos show:

```bash
pnpm build
node scripts/record-demos.mjs
```

## Releasing

variant ships as an npm package; there is no server to deploy. Releases are
manual; the only workflows in the repository are `ci.yml` and `benchmark.yml`.

1. Confirm CI is green on `master`.
2. Bump the version and move the `[Unreleased]` notes in
   [CHANGELOG.md](./CHANGELOG.md) under it.
3. If the example workflows or `examples/monorepo` pin a version, bump it too.
4. `pnpm publish`. `prepublishOnly` runs `pnpm test:all && pnpm build` first.
5. Tag the commit `variant@x.y.z`.

Only `dist/` is published (`files: ["dist"]`), plus the README, LICENSE and
`package.json` that npm always includes. The package is ESM-only and exposes
`.` through its `exports` map. While it is `0.x`, breaking changes to the public
API can ship in any minor release; record each one in the CHANGELOG.

## Commit messages

All commits follow the conventional commit format:

```
<type>: <subject>

[optional body]

[optional footer]
```

| Type | Purpose | Example |
|------|---------|---------|
| `feat` | New feature | `feat: resolve tsconfig paths aliases in the symbol graph` |
| `fix` | Bug fix | `fix: prevent cache miss when packageScopes is empty` |
| `perf` | Performance improvement | `perf: short-circuit DAG level computation on cache hit` |
| `refactor` | Code refactoring | `refactor: simplify createContext workspace wiring` |
| `test` | Test additions/changes | `test: add integration tests for pnpm workspace detection` |
| `docs` | Documentation | `docs: document scheduler policy options in README` |
| `chore` | Build/tooling changes | `chore: update biome to 2.x` |
| `types` | Type definition updates | `types: tighten VariantContext packageScopes inference` |
| `ci` | CI/CD changes | `ci: add coverage threshold enforcement to CI workflow` |

**Subject line:** imperative mood, no trailing period, at most 72 characters.

**Body:** wrap at 72 characters; explain what and why, not how; reference issue
numbers when applicable.

## PR requirements

All PRs must pass `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and
`pnpm build`. Run `pnpm check` locally to fix formatting and lint issues before
pushing.

- Changed behavior needs a test; a bug fix needs a test that fails before it.
- Behavior users can observe needs a `docs/` update in the same PR.
- Bump one dependency at a time, never a blanket `pnpm update`, so lockfile
  diffs stay reviewable.

The pre-commit hook (`.husky/pre-commit`) gates every commit through
`pnpm format:check` → `pnpm lint` → `pnpm typecheck` → `pnpm test:run`, in that
order; each step must pass before the next runs.
