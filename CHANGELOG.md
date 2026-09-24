# Changelog

All notable changes to variant are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions here are the `@blzsky/variant` package, which started at 0.1.0 when the project
was renamed to variant. Everything published before that — `antiscaler` 0.1.0
through 1.1.1, then `linkctl` 2.0.0 — is in
[CHANGELOG-archive.md](./CHANGELOG-archive.md). The two series reuse the same
numbers, so they are kept apart rather than interleaved: git tags for this
series are `variant@x.y.z`, and the archived series keeps its bare `vx.y.z` tags.

## [Unreleased]

### Added

- **`docs/tutorial.md`**, a fifteen-minute walkthrough of every
  change-intelligence command on a sample monorepo, with output captured from
  real runs.
- **`docs/cli-reference.md`**: every command and flag, exit and error codes,
  how each command compares `--base`, what is analyzed, and what is written
  under `.variant/`.
- **`docs/api.md`**: `defineConfig` and the config types, the shape of every
  `--json` output and of the `pr report` markdown, and the history-file
  records.
- **`examples/`**: the sample monorepo the tutorial uses, and GitHub Actions
  workflows for a sticky `pr report` comment, a `workspace check` gate, and
  shadow-mode reconciliation with `impact verify`.
- Terminal demos in `docs/assets/`, recorded from the real CLI by
  `scripts/record-demos.mjs`.

### Changed

- The README is now for users: logo, badges, a recorded demo, a quick start and
  a documentation index. Setup, architecture, testing and release notes moved
  to `CONTRIBUTORS.md`.

### Fixed

- **A `--base` ref that names no commit is now an error** (`GIT_REF_ERROR`,
  exit 1) in `impact`, `diff`, `pr check` and `pr report`. `pr check` and
  `pr report` used to report zero changed files and `safe to skip build`, and
  `impact` printed "could not determine changed files" and exited 0, so a
  mistyped ref, or a CI checkout with no local `main`, passed as a clean
  result. `pr check` and `pr report` also fail when the ref shares no merge
  base with `HEAD`, as in a shallow clone. This changes an exit code: the
  default `impact --base HEAD~1` in a repository with a single commit now
  fails instead of printing a message.
- **Comments and whitespace in a file with a template substitution or a regex
  are non-impacting again.** The differ's tokenizer could not find the end of
  a `${…}` substitution or tell a regex from a division, so the rest of the
  file scanned as one token that kept its whitespace. The base version comes
  from git without its final newline, so any edit to such a file, a comment
  included, classified as `internal` and selected every test that imported
  it. The tokenizer now rescans both the way the TypeScript parser does. JSX
  text is still scanned as code, so the same can happen in a `.tsx` file whose
  JSX contains an apostrophe; it only ever widens the result.
- The README said a dependent that never imports the changed names is not
  selected. That holds for the blast radius, not for test selection: every
  test that imports a changed file runs. The README and
  `docs/getting-started.md` now say so.
- The README's CI step passed `--base ${{ github.base_ref }}`, which names no
  ref in a default `actions/checkout` clone, so the report came out empty. The
  docs and examples now check out with `fetch-depth: 0` and pass
  `origin/<branch>`.
- `docs/monorepo.md` and `docs/troubleshooting.md` said workspace packages are
  discovered from tsconfig project references, which are not read. They now
  list the actual fallback: `packages/*`, `apps/*` and `services/*`.
- `docs/troubleshooting.md` fixed `variant: command not found` by running
  `variant build`, the command that was not found. It now uses
  `npx @blzsky/variant`.

## [0.2.0] - 2026-09-17

Cut to the part nobody else does. variant is a change-intelligence tool for
TypeScript monorepos: what a change affects, and which tests it needs. The task
runner stays, frozen, because it carries the cache-key invariants and dogfoods
the repo — but it is no longer what the project is about.

Every removal below is breaking. There is no shim; delete the corresponding
config keys.

### Added

- **`variant impact verify <report>`** — reconciles a logged prediction against
  a Vitest (`--reporter=json`) or Jest (`--json`) report and reports **false
  skips**: tests that failed and that the prediction did not select. This closes
  the shadow-mode loop. `readImpactPredictions` finally has a caller outside its
  own tests, and each reconciliation is appended to
  `.variant/history/reconciliation.jsonl` so a rate accumulates across runs.
- Predictions now record `headSha`, the commit they were made against, so a
  prediction can be matched to the test run that actually happened. Without it
  the log recorded what variant thought with nothing to check it against.
  `impact verify --head-sha <sha>` selects a specific run.
- `ImpactReportError` (`IMPACT_REPORT_ERROR`), for a test report that cannot be
  read as one.

### Removed

- **The tracer.** `src/tracer/`, the `@blzsky/variant/tracer` export and its `tsup` entry
  point, the `trace` and `trace analyze` commands, and `.variant/traces/`. It
  needed a plugin inside the user's dev server, only covered Next and Vite, and
  fed nothing into the impact pipeline.
- **Everything that read a trace session**: `pr replay`, `build --scope` and
  `--trace`, `performance.criticalPaths`, `performance.lintOnlyForNonCritical`
  (and with it `VariantContext.lintOnly`), and the `doctor` trace check.
- **The remote cache.** The HTTP and S3 backends, `cache.remote`,
  `cache.costPerMissMs`, `RunOptions.remoteCache`, `TaskRunResult.remoteHit`,
  and the remote hit/time-saved fields on `InsightSummary`. It only mattered to
  someone using variant as their build orchestrator. `@aws-sdk/client-s3` is no
  longer referenced at all.
- **The `dev` command.**

### Changed

- `pr report` no longer embeds a `replay` object; it renders the `pr check`
  verdict alone, and drops `--session`.
- `--help` leads with `impact`, `diff`, `workspace` and `pr`; the task-runner
  commands follow.
- The CLI description is now "Change intelligence and task orchestration for
  TypeScript monorepos".
- `README.md` and `docs/getting-started.md` lead with `variant impact` against
  a real repository, with no config file.
- Removed `docs/nextjs.md`, `docs/vite.md` and `docs/remote-cache.md`.

### Fixed

- **tsconfig `paths` aliases now resolve**, closing one of the two known
  under-selection gaps. An import reaching its target only through an alias
  (`@/lib/date`) previously landed in `unresolved`: the change did not
  propagate to the file's real importers and `impact` under-selected the tests
  — a false skip, reported at full confidence. `compilerOptions.paths` is read
  through the TypeScript compiler's own config parser, so JSONC, `extends`
  chains and `baseUrl` behave as `tsc` does rather than as a reimplementation
  of it. A workspace package still wins over an alias sharing its prefix, and
  an alias that matches a pattern but names no indexed file is now reported as
  `unresolved` instead of being counted as an external package.
- **Package `exports` maps are now read**, closing the second under-selection
  gap. A bare import of a sibling workspace package consults that package's
  `exports` — conditional exports, fallback arrays and `*` subpath patterns
  included — before falling back to the conventional `src/index.*` guesses.

  Because `exports` names published entry points that usually do not exist in a
  source checkout, a target of `./dist/entry.js` is also probed as `src/entry`,
  `lib/entry`, `source/entry` and `entry`. Reproduced before fixing: a workspace
  package exporting `.` as `./dist/entry.js` with its source at `lib/entry.ts`
  selected 0 of 2 test files.

  The layer is strictly additive — a package with no `exports`, or whose targets
  name no indexed file, resolves exactly as it did before.
- `impact` said "1 test files"; test-file counts are pluralized.

## [0.1.0] - 2026-09-17

Renamed to **variant** and republished under a new npm name, so the version
resets to `0.1.0`. `0.x` is honest about where the project is: breaking changes
ship in minor releases and are recorded here.

### Changed

- **Renamed the project to `variant`.** The npm package is `@blzsky/variant`.
  The unscoped name was not available: `variant` and `variant-ts` belong to
  unrelated packages, and npm's typosquat filter rejected both `vrnt` ("too
  similar to vant, varint, grunt, ret") and `variantjs`. Scoping sidesteps that
  filter, which only applies to unscoped names. Everything a user
  reads or types is `variant`: the `bin`, the config file (`variant.config.ts`), the
  state directory (`.variant/`), the `VARIANT_*` environment variables, the
  exported types (`VariantConfig`, `VariantContext`, `VariantError`), the
  tracer plugins (`variantVitePlugin`, `variantNextPlugin`) and the default S3
  key prefix (`variant/`).

  `npx @blzsky/variant <command>` addresses the package; `variant <command>` is the
  installed binary. npm runs a package's sole binary even when its name differs
  from the package, so both work.

  There is no compatibility shim. `linkctl.config.*` is no longer read, and a
  local checkout must move `linkctl.config.ts` to `variant.config.ts` and
  `.linkctl/` to `.variant/`. The old `.linkctl/` cache is orphaned, not
  migrated; delete it.

- **Dropped the semver stability promise** from `src/index.ts`, `src/tracer/`
  and the README. It predated the decision that breaking changes are acceptable
  while the package has no users, and contradicted it.

### Fixed

- The 2.0.0 entry (now in [CHANGELOG-archive.md](./CHANGELOG-archive.md))
  claimed nothing had been published under the old name. True of `link`; the
  versions below 2.0.0 shipped as `antiscaler`.
- `docs/pr-commands.md` described a `.github/workflows/pr-report.yml` that was
  never committed. It now shows the step to copy into your own workflow.
- `benchmarks/README.md` said the benchmark job runs on pushes to `alpha`; it
  runs on `master`.

### Removed

- The `echoQuoted` smoke task and the stale phase-gate comments in the dogfood
  config. Quoted-argv parsing is covered by the executor's unit tests.

[Unreleased]: https://github.com/saintparish4/variant/compare/variant@0.2.0...HEAD
[0.2.0]: https://github.com/saintparish4/variant/compare/variant@0.1.0...variant@0.2.0
[0.1.0]: https://github.com/saintparish4/variant/releases/tag/variant@0.1.0
