# Contributing to variant

## Dev Setup

```bash
git clone <repo-url>
cd variant
pnpm install

# Formatting → Linting → Typechecking (read-only gate, same order as CI / pre-commit)
pnpm format:check
pnpm lint
pnpm typecheck

# Format only (writes in place)
pnpm format

# Autofix format + lint + organize imports (writes in place) — use locally
pnpm check

# Build all entry points — required before running E2E tests
pnpm build

# Smoke test the built CLI
node dist/cli.js --help

# Run every tier once
pnpm test:run

# Run one tier
pnpm test:integration   # boundaries
pnpm test:e2e           # user workflows (requires dist/ — run pnpm build first)

# Run all tests + coverage
pnpm test:all
```

## Architecture Overview

```
src/
├── cli/                  # Commander-based CLI entry and commands
│   ├── index.ts          # Program definition, lazy command registration
│   ├── context.ts        # createContext() — DRY bootstrap for all commands
│   ├── execute.ts        # Shared run path for build/dev/run (progress + insights)
│   ├── commands/         # One file per command — parse, delegate, render
│   ├── render/           # All terminal output; writes through the Printer
│   └── visuals/          # Printer, colors, spinners, prompts, ANSI primitives
│
├── core/
│   ├── config/
│   │   ├── schema.ts     # Zod schema with defaults
│   │   └── loader.ts     # Finds and loads variant.config.ts via jiti
│   │
│   ├── graph/
│   │   ├── dag.ts        # TaskGraph class — addTask, addDependency, toLevels
│   │   ├── package-graph.ts  # Workspace discovery and cross-package task generation
│   │   ├── planner.ts    # buildGraph() — config -> TaskGraph
│   │   ├── validation.ts # validateTaskGraph() — backs `variant check`
│   │   ├── workspace-check.ts  # Pure declared-vs-imported dependency audit
│   │   └── workspace-audit.ts  # Gathers manifests + symbol graph, runs the audit
│   │
│   ├── cache/
│   │   ├── hashing.ts    # SHA-256 content hashing via fast-glob + crypto
│   │   ├── store.ts      # Read/write JSON cache file
│   │   └── git-diff.ts   # Git-diff pre-filter for package scoping
│   │
│   ├── vcs/
│   │   └── git.ts        # The git porcelain every capability reads through
│   │
│   ├── execution/
│   │   ├── executor.ts   # executeTask() — runs command via execa
│   │   ├── runner.ts     # runTasksWithDeps() — level-parallel DAG runner
│   │   └── scheduler.ts  # Event-driven scheduler (starts tasks as deps finish)
│   │
│   ├── detection/
│   │   ├── project.ts         # detectProject() — aggregates all detectors
│   │   ├── packageManager.ts  # npm / yarn / pnpm detection
│   │   ├── runtime.ts         # Node / Bun / Deno detection
│   │   └── framework.ts       # Next.js / Vite / generic detection
│   │
│   ├── insight/
│   │   └── analyzer.ts   # computeInsights() — stats from results + cache
│   │
│   ├── doctor/
│   │   └── diagnostics.ts    # Environment checks behind `variant doctor`
│   │
│   ├── pr/
│   │   ├── check.ts      # Classify a PR's TypeScript changes into a verdict
│   │   ├── replay.ts     # Intersect PR changes with a recorded trace session
│   │   └── report.ts     # Combined check + replay, as JSON or markdown
│   │
│   ├── impact/
│   │   └── predict.ts    # Test-impact prediction plus shadow-mode logging
│   │
│   ├── scaffold/
│   │   └── config-template.ts  # Defaults and template behind `variant init`
│   │
│   ├── plugins/
│   │   ├── types.ts      # BuildPlugin interface and hook signatures
│   │   └── registry.ts   # PluginRegistry — fans out hook calls
│   │
│   ├── progress/
│   │   └── reporter.ts   # The progress port; every renderer lives in cli/
│   │
│   ├── scope/
│   │   ├── trace-loader.ts   # Reads recorded trace sessions
│   │   ├── trace-summary.ts  # Reduces a session to the `trace analyze` numbers
│   │   ├── trace-scope.ts    # Resolves --scope to the packages a session hit
│   │   ├── task-filter.ts    # Package sets -> runner predicates and priorities
│   │   └── critical-path.ts  # Checks changed files against critical routes
│   │
│   ├── semantic/
│   │   ├── differ.ts     # AST-based diff classifier via ts-morph
│   │   ├── file-change.ts    # Classifies a file against a git ref
│   │   ├── verdict.ts    # Shared build verdict for `pr check` and `impact`
│   │   ├── blast-radius.ts   # Reverse-graph traversal from changed files
│   │   └── test-impact.ts    # Which tests a change requires
│   │
│   └── errors.ts         # VariantError hierarchy (Config, Cycle, Task, Cache)
│
├── adapters/             # Concrete adapter implementations
│   ├── types.ts          # Adapter interfaces
│   ├── pm/               # npm.ts, yarn.ts, pnpm.ts
│   ├── runtimes/         # node.ts, bun.ts, deno.ts
│   └── frameworks/       # next.ts, vite.ts, generic.ts, plugin.ts
│
├── tracer/               # Module tracing plugins
│   ├── next-plugin.ts    # Webpack plugin for Next.js
│   ├── vite-plugin.ts    # Vite plugin
│   └── writer.ts         # Writes trace sessions to .variant/traces/
│
└── types/
    └── index.ts          # Shared type definitions (VariantContext, TaskGraph, etc.)
```

### Key Design Decisions

- **Lazy imports**: The CLI entry (`index.ts`) defines commands with inline
  `action()` callbacks that use dynamic `import()`. This keeps
  `variant --help` fast (< 100ms) by avoiding loading heavy deps (execa,
  jiti, fast-glob) until a command actually runs.
- **DI in the runner**: `runTasksWithDeps` accepts a `TaskExecutor` parameter
  (defaults to the real `executeTask`). Tests inject a mock executor.
- **Typed errors**: Every failure path throws an `VariantError` subclass
  with a machine-readable `.code` string. The CLI error boundary formats
  these for the user.
- **`core` never prints**: `core` reports through the progress port and throws
  typed errors; every byte of terminal output is produced in `cli/render/` and
  written through the `Printer`, which is what makes `-q`/`-v` work uniformly.
  A `console.log` in `core` — or anywhere outside `cli/render` — is a bug.

## How to Add an Adapter

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

2. Register it in `src/core/detection/packageManager.ts` — add the adapter
   to the detection list. The detector checks for the lockfile and returns
   the first match.

3. Add a test in `src/core/detection/__tests__/packageManager.test.ts`
   verifying that when `bun.lockb` exists, the bun adapter is returned.

## Testing Guide

Tests use Vitest, split into three tiers — see the Testing section of
`CLAUDE.md` for which tier a given test belongs in:

- **Unit** — isolated behavior, one module with its collaborators substituted.
  Lives next to the code it tests inside `__tests__/` directories.
- **Integration** — boundaries between real modules, or a real edge such as the
  filesystem or git. Lives in `src/__tests__/integration/`.
- **E2E** — user workflows driven through the built `dist/cli.js`. Lives in
  `src/__tests__/e2e/`.

Fixture workspaces are shared across tiers at `src/__tests__/fixtures/`.

```bash
# Build first — E2E tests require dist/cli.js
pnpm build

# Run all tests once
pnpm test:run

# Run a specific test file
pnpm vitest run src/core/graph/__tests__/dag.test.ts

# Run a single tier
pnpm test:integration
pnpm test:e2e

# Watch mode
pnpm test

# Run with coverage
pnpm test:all
```

### Test Categories

- **P0 (critical)**: DAG cycle detection, config loading with defaults,
  content hashing determinism
- **P1 (important)**: Cache hit/miss, runner level parallelism, task
  failure propagation, strict mode bypass

### Writing Tests

- Mock the `TaskExecutor` in runner tests (don't shell out in unit tests)
- Use `mkdtemp` for cache store tests that need filesystem
- Keep tests focused: one behavior per `it()` block

## Commit Messages

All commits must follow the conventional commit format:

```
<type>: <subject>

[optional body]

[optional footer]
```

| Type | Purpose | Example |
|------|---------|---------|
| `feat` | New feature | `feat: add critical-path route scoping to trace analyze` |
| `fix` | Bug fix | `fix: prevent cache miss when packageScopes is empty` |
| `perf` | Performance improvement | `perf: short-circuit DAG level computation on cache hit` |
| `refactor` | Code refactoring | `refactor: simplify createContext workspace wiring` |
| `test` | Test additions/changes | `test: add integration tests for pnpm workspace detection` |
| `docs` | Documentation | `docs: document scheduler policy options in README` |
| `chore` | Build/tooling changes | `chore: update biome to 2.x` |
| `types` | Type definition updates | `types: tighten VariantContext packageScopes inference` |
| `ci` | CI/CD changes | `ci: add coverage threshold enforcement to CI workflow` |

**Subject line rules:** imperative mood, no trailing period, max 72 characters, capitalize first letter.

**Body:** wrap at 72 characters; explain what and why, not how; reference issue numbers when applicable.

## PR Requirements

All PRs must pass `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` before review. Run `pnpm format` (or `pnpm check`) locally to fix formatting and lint issues before pushing.

The pre-commit hook (`.husky/pre-commit`) gates every commit through `pnpm format:check` → `pnpm lint` → `pnpm typecheck` → `pnpm test:run`, in that order — each step must pass before the next runs.
