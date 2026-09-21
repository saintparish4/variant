# variant

[![npm version](https://img.shields.io/npm/v/@blzsky/variant.svg)](https://www.npmjs.com/package/@blzsky/variant)
[![CI](https://github.com/saintparish4/variant/actions/workflows/ci.yml/badge.svg)](https://github.com/saintparish4/variant/actions/workflows/ci.yml)

Change intelligence for TypeScript monorepos. variant reads a diff at the AST level and answers one question: **which tests does this change actually need, and how sure are we?**

```console
$ npx @blzsky/variant impact --base HEAD~1

Base ref: HEAD~1

You changed 1 file.
  internal       src/math.ts

Impact: 1 file

Run:   1 test file
Skip:  1 test file (of 2 total)

Verdict:    build recommended
Confidence: 100%  (report-only — run the full suite; skipping unlocks after shadow-mode validation)
```

`internal` means the exported signature did not change — only the body — so a dependent that never imports the changed names is not selected. That distinction is the point: test runners and build orchestrators decide "affected" from the file or package graph; variant decides it from the exported surface.

No config file is required.

**`impact` is report-only and stays that way until it is measured.** Every prediction is appended to `.variant/history/impact.jsonl` so a false-skip rate can be reconciled against real test results. The printed confidence is a graph-resolution score, not a safety number. Until that rate is published, run the full suite.

A cached task DAG (`build`, `run`, `insight`) sits underneath, and dogfoods the repo.

---

## Quick start

Node ≥ 20 and a git repository with at least one prior commit. Nothing to configure:

```bash
npx @blzsky/variant impact --base origin/main
```

To keep it in a project:

```bash
npm install -D @blzsky/variant    # or pnpm add -D / yarn add -D
```

The package is `@blzsky/variant`; the binary it installs is `variant`. (`npx variant` fetches an unrelated package of that name — always scope it.)

```bash
variant impact --base origin/main     # which tests does this branch need?
variant diff src/api/checkout.ts      # classify one file's change
variant pr check --base main          # one build verdict for the whole PR
```

In CI, `pr report` renders the verdict as a comment-ready artifact and `workspace check` exits 1 on an undeclared dependency:

```yaml
- run: npx @blzsky/variant pr report --base ${{ github.base_ref }} --markdown --output report.md
- run: npx @blzsky/variant workspace check
```

To check a prediction against what actually happened, keep the test runner's JSON report and reconcile it:

```bash
npx vitest run --reporter=json --outputFile=report.json
variant impact verify report.json     # reports false skips
```

Walkthrough: [docs/getting-started.md](./docs/getting-started.md). Then [impact & workspace](./docs/impact-and-workspace.md), [PR commands](./docs/pr-commands.md), [monorepos](./docs/monorepo.md), [config reference](./docs/config-reference.md), [troubleshooting](./docs/troubleshooting.md).

---

## Commands

Change intelligence — what variant is for:

| Command | What it does |
|---|---|
| `impact` | Predict which tests a change requires, and how much of the import graph resolved. Report-only. `--base <ref>` (default `HEAD~1`), `--json` |
| `impact verify <report>` | Reconcile a logged prediction against a Vitest (`--reporter=json`) or Jest (`--json`) report, and report false skips. `--head-sha <sha>`, `--json` |
| `diff <file>` | Classify one TypeScript file's change as non-impacting / internal / breaking. `--base <ref>` |
| `pr check` | Classify every TypeScript change in the PR and roll them up to a build verdict. `--base <ref>` (default `main`) |
| `pr report` | The `pr check` verdict as a structured artifact. `--markdown`, `--output <file>`, `--base <ref>` |
| `workspace check` | CI gate: packages importing dependencies they do not declare. Exits 1 on violations. `--json` |

Task orchestration — the cached DAG underneath, frozen at feature parity because it carries the cache-key invariants and dogfoods this repo:

| Command | What it does |
|---|---|
| `build` | Run the `build` task across the workspace. `--affected`, `-c, --concurrency <n>`, `--dry-run` |
| `run <task>` | Run a named task with its dependencies |
| `insight` | Task timing and cache-hit stats |

Setup and diagnostics:

| Command | What it does |
|---|---|
| `init` | Scaffold `variant.config.ts` in the current directory |
| `doctor` | Validate config and diagnose common issues |
| `check` | Validate config and task graph without executing anything |
| `env` | Show the detected runtime, package manager and framework |

Global flags, accepted by every command: `-q`/`-qq` (quieter, silent), `-v` (verbose), `--color <auto\|always\|never>`, `--no-color`, `--no-progress`, `-V`, `-h`. Run `variant help <command>` for the full option list.

---

Everything below is for working **on** variant itself. Using it in your own project is [docs/](./docs/getting-started.md).

---

## Requirements

For developing variant. Using it needs only Node ≥ 20 and git.

| | Version | Notes |
|---|---|---|
| Node | ≥ 20 | Enforced via `engines`; CI tests 20, 22, and 24 |
| pnpm | ≥ 10 | Pinned by `packageManager` |
| git | any recent | Needed to exercise `--affected`, `diff`, `impact`, and `pr *` — they no-op without a repo |

Optional: **[hyperfine](https://github.com/sharkdp/hyperfine)**, required by `pnpm bench`.

---

## Local setup

```bash
git clone https://github.com/saintparish4/variant.git
cd variant
pnpm install
pnpm build               # required before the CLI or E2E tests can run
node dist/cli.js --help  # smoke test
```

---

## Development

```bash
pnpm build             # compile all three entry points to dist/ via tsup
pnpm clean             # delete dist/
pnpm format            # biome format --write .
pnpm format:check      # biome format (read-only)
pnpm lint              # biome check . (static analysis, read-only)
pnpm typecheck         # tsc --noEmit
pnpm check             # biome check --write — local autofix (format + lint + organize imports)
pnpm bench             # benchmark harness (pnpm bench:quick for a fast pass)
```

The default branch is `master`, and it is expected to be lint-clean — if `pnpm format:check`, `pnpm lint`, or `pnpm typecheck` is red, your change caused it.

There is no watch build. The loop is `pnpm build && node dist/cli.js <command>`, run against a scratch project or one of the fixture workspaces in `src/__tests__/fixtures/`.

`src/cli/index.ts` registers every command with a dynamic `import()` inside its `action()` callback, deferring execa, jiti, and fast-glob until a command actually runs. That is what keeps `variant --help` fast, and it is the one sanctioned exception to the project's prefer-top-level-imports rule — the benchmark job fails if startup regresses past 200 ms.

Benchmark methodology and how to reproduce the published numbers: [benchmarks/README.md](./benchmarks/README.md).

---

## Testing

Three tiers, each answering a different question. Write a test at the cheapest tier that can answer yours.

| Tier | Tests | Lives in | Runs against |
|------|-------|----------|--------------|
| Unit | Isolated behavior — one module, collaborators substituted | `src/**/__tests__/*.test.ts` | Source |
| Integration | Boundaries — real modules meeting, or a real edge (filesystem, git, config) | `src/__tests__/integration/` | Source |
| E2E | User workflows through the shipped binary | `src/__tests__/e2e/` | Built `dist/` |

```bash
pnpm test              # watch mode
pnpm test:run          # every tier, once
pnpm test:integration  # boundaries only
pnpm test:e2e          # workflows only — run pnpm build first
pnpm test:all          # everything + coverage
pnpm vitest run src/core/graph/__tests__/dag.test.ts   # a single file
```

Unit tests never shell out — `runTasksWithDeps` takes a `TaskExecutor`, so tests inject a mock. Fixture workspaces are shared across tiers at `src/__tests__/fixtures/`. Coverage gates in CI: 70% lines/statements/functions, 60% branches.

---

## Environment Variables

variant takes no configuration from the environment — that lives in `variant.config.ts`. What it reads are standard terminal and CI signals:

| Variable | Read by | Effect |
|---|---|---|
| `NO_COLOR` | `visuals/color.ts` | Disables color everywhere. Highest-priority env signal. |
| `FORCE_COLOR` | `visuals/color.ts` | Forces color on when output is not a TTY. |
| `CLICOLOR_FORCE` | `visuals/color.ts` | Same as `FORCE_COLOR`. |
| `CI` | picocolors, indirectly | Nothing in `src/` reads `CI`. picocolors counts it as color *support*, so CI logs keep color unless `NO_COLOR` is set. Animated progress stops in CI because stderr is not a TTY (`printer.ts:82`), not because of this variable. |
| `JPY_SESSION_NAME` | `visuals/progress.ts` | Detects a Jupyter session and falls back to line-based output. |
| `VARIANT_TEST_NO_CLI_PROGRESS` | `visuals/printer.ts`, `visuals/progress.ts` | Test-only. Suppresses progress bars so concurrent output stays assertable. |

Color precedence: `--color <when>` → `--no-color` → `NO_COLOR` → `FORCE_COLOR`/`CLICOLOR_FORCE` → TTY detection. All of it resolves once in `visuals/color.ts:resolveColorChoice()`, applied process-wide by `writeGlobalColorChoice()`; renderers call `getColors()` and never consult the environment themselves. Adding a second color path is the mistake this design exists to prevent.

---

## Architecture

Layered, dependencies pointing one way: `cli → core → adapters`. Ports are owned by `core`; adapters implement them and import nothing from `core` except types.

| Directory | Role |
|---|---|
| `src/cli/` | Commander wiring, option parsing, terminal rendering |
| `src/core/` | Orchestration logic, grouped by capability — `semantic`, `impact`, `pr`, `cache`, `graph`, `execution`, `detection`, `plugins` |
| `src/adapters/` | The outside world — package managers, runtimes, frameworks |
| `src/types/` | Contracts shared across layers |

`tsup` builds two entry points: `dist/index.js` (library API) and `dist/cli.js` (the `variant` binary).

The request path for most commands: `cli/context.ts:createContext()` loads config, detects PM/runtime/framework, builds the task DAG, and computes git-diff scoping — then `core/execution:runTasksWithDeps()` walks DAG levels while `core/cache` hashes inputs against `.variant/cache/cache.json`.

Along the way `core/provenance` records why each task was selected to run — cache miss, affected by the diff, or never cached. The runner attaches that record to the `VariantError` a failing task throws, and `cli/render/error.ts` prints it under the failure. It explains *selection*, never *cause*; see [docs/troubleshooting.md](./docs/troubleshooting.md) for the output and that distinction.

Two rules to know before your first PR: business logic does not live in command handlers, and `core` never prints or exits — it throws `VariantError` subclasses and lets the CLI top level map them to exit codes (`VariantError` → 1, unexpected → 2). Full detail in [CLAUDE.md](./CLAUDE.md).

Note the naming: `core/progress/reporter.ts` is a *port* — a bare `TaskEvent` interface with no output code. Everything that actually draws lives in `cli/visuals/` (progress, spinners, task events) and `cli/render/` (command output, errors). A file under `core/` never prints, whatever its name suggests.

---

## Deployment

variant ships as an npm package; there is no server to deploy.

```bash
pnpm publish            # prepublishOnly runs `pnpm test:all && pnpm build`
```

Only `dist/` is published (`files: ["dist"]`). The package exposes `.` through the `exports` map, ESM-only (`"type": "module"`).

Releases are **manual**; the only workflows in the repository are `ci.yml` and `benchmark.yml`. Before publishing: bump the version, update [CHANGELOG.md](./CHANGELOG.md), and confirm CI is green on `master`.

The package is `0.x` and makes no semver stability promise yet. Breaking changes to the `@blzsky/variant` public API can ship in any minor release; each one is recorded in [CHANGELOG.md](./CHANGELOG.md).

---

## Contributing

Read [CONTRIBUTORS.md](./CONTRIBUTORS.md) for the full workflow and [CLAUDE.md](./CLAUDE.md) for architecture and code-style rules. The short version:

- All PRs must pass `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`.
- Changed behavior needs a test; a bug fix needs a test that fails before it.
- Behavior changes that users can observe need a `docs/` update in the same PR.
- Conventional commits: `<type>: <subject>`, imperative mood, ≤ 72 chars, no trailing period.
- Bump one dependency at a time — never a blanket `pnpm update` — so lockfile diffs stay reviewable.

---

## License

MIT — see [LICENSE](./LICENSE).
