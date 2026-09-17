# variant

[![npm version](https://img.shields.io/npm/v/vrnt.svg)](https://www.npmjs.com/package/vrnt)
[![CI](https://github.com/saintparish4/variant/actions/workflows/ci.yml/badge.svg)](https://github.com/saintparish4/variant/actions/workflows/ci.yml)

Change intelligence for TypeScript monorepos: an AST-level view of what a change affects and which tests it needs, on top of a task DAG with content-based caching.

Published to npm as **`vrnt`**; the command it installs is **`variant`**.

This README is for working **on** variant. Using it in your own project is documented in [docs/](./docs/getting-started.md).

---

## Requirements

| | Version | Notes |
|---|---|---|
| Node | ≥ 20 | Enforced via `engines`; CI tests 20, 22, and 24 |
| pnpm | ≥ 10 | Pinned by `packageManager` |
| git | any recent | Needed to exercise `--affected`, `diff`, `impact`, and `pr *` — they no-op without a repo |

Optional, only if you touch the matching area:

- **`@aws-sdk/client-s3`** — dynamically imported by the S3 remote-cache backend (`s3-adapter.ts:49`) and deliberately not a declared dependency. Install it locally to exercise that path.
- **[hyperfine](https://github.com/sharkdp/hyperfine)** — required by `pnpm bench`.

---

## Installation

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

Link takes no configuration from the environment — that lives in `variant.config.ts`. What it reads are standard terminal and CI signals:

| Variable | Read by | Effect |
|---|---|---|
| `NO_COLOR` | `visuals/color.ts` | Disables color everywhere. Highest-priority env signal. |
| `FORCE_COLOR` | `visuals/color.ts` | Forces color on when output is not a TTY. |
| `CLICOLOR_FORCE` | `visuals/color.ts` | Same as `FORCE_COLOR`. |
| `CI` | picocolors, indirectly | Nothing in `src/` reads `CI`. picocolors counts it as color *support*, so CI logs keep color unless `NO_COLOR` is set. Animated progress stops in CI because stderr is not a TTY (`printer.ts:82`), not because of this variable. |
| `JPY_SESSION_NAME` | `visuals/progress.ts` | Detects a Jupyter session and falls back to line-based output. |
| `VARIANT_TEST_NO_CLI_PROGRESS` | `visuals/printer.ts`, `visuals/progress.ts` | Test-only. Suppresses progress bars so concurrent output stays assertable. |
| `VARIANT_TRACE` | Set by `variant trace` | Exported to the spawned dev process. Nothing in Link reads it back — the tracer plugins are unconditional once installed. |

Color precedence: `--color <when>` → `--no-color` → `NO_COLOR` → `FORCE_COLOR`/`CLICOLOR_FORCE` → TTY detection. All of it resolves once in `visuals/color.ts:resolveColorChoice()`, applied process-wide by `writeGlobalColorChoice()`; renderers call `getColors()` and never consult the environment themselves. Adding a second color path is the mistake this design exists to prevent.

To exercise the S3 remote-cache backend locally, note that the config schema has no credential fields — `cli/context.ts` passes only `bucket`, `prefix`, `region`, and `endpoint`, so authentication comes entirely from the AWS SDK default chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_REGION`) or an instance/OIDC role. Keep credentials out of config files; they are committed.

---

## Architecture

Layered, dependencies pointing one way: `cli → core → adapters`. Ports are owned by `core`; adapters implement them and import nothing from `core` except types.

| Directory | Role |
|---|---|
| `src/cli/` | Commander wiring, option parsing, terminal rendering |
| `src/core/` | Orchestration logic, grouped by capability — `cache`, `graph`, `execution`, `semantic`, `scope`, `detection`, `plugins` |
| `src/adapters/` | The outside world — package managers, runtimes, frameworks |
| `src/tracer/` | Webpack and Vite plugins that record module resolution |
| `src/types/` | Contracts shared across layers |

`tsup` builds three entry points: `dist/index.js` (library API), `dist/cli.js` (the `variant` binary), and `dist/tracer.js` (framework plugins).

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

Only `dist/` is published (`files: ["dist"]`). The package exposes `.` and `./tracer` through the `exports` map, both ESM-only (`"type": "module"`).

Releases are **manual**; the only workflows in the repository are `ci.yml` and `benchmark.yml`. Before publishing: bump the version, update [CHANGELOG.md](./CHANGELOG.md), and confirm CI is green on `master`.

The package is `0.x` and makes no semver stability promise yet. Breaking changes to `vrnt` or `vrnt/tracer` can ship in any minor release; each one is recorded in [CHANGELOG.md](./CHANGELOG.md).

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
