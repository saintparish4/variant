# CLI reference

Every command, flag, exit code and file the `variant` binary knows about. For a
guided run through the commands, see the [tutorial](./tutorial.md); for the JSON
each command prints, see the [API reference](./api.md).

```
variant [global options] <command> [options]
```

Installed as a dev dependency, the binary is `variant`. Without installing,
run `npx @blzsky/variant <command>`. `npx variant` fetches an unrelated package.

- [Global options](#global-options)
- [Environment variables](#environment-variables)
- [Exit codes and errors](#exit-codes-and-errors)
- [Refs and diffs](#refs-and-diffs)
- [What gets analyzed](#what-gets-analyzed)
- Change intelligence: [`impact`](#impact) · [`impact verify`](#impact-verify) · [`diff`](#diff) · [`pr check`](#pr-check) · [`pr report`](#pr-report) · [`workspace check`](#workspace-check)
- Task orchestration: [`build`](#build) · [`run`](#run) · [`insight`](#insight)
- Setup and diagnostics: [`init`](#init) · [`doctor`](#doctor) · [`check`](#check) · [`env`](#env)
- [Files variant writes](#files-variant-writes)

## Global options

Accepted before any command.

| Flag | Effect |
|---|---|
| `-q`, `--quiet` | Suppress normal output, JSON included. Errors still print to stderr. `-qq` (silent) is accepted and currently behaves the same. |
| `-v`, `--verbose` | More output. |
| `--no-progress` | Hide progress bars and spinners. |
| `--color <when>` | `auto` (default), `always` or `never`. |
| `--no-color` | Same as `--color never`. |
| `-V`, `--version` | Print the version. |
| `-h`, `--help` | Help for the program, or for a command: `variant help <command>`. |

## Environment variables

variant takes no configuration from the environment; that lives in
[`variant.config.ts`](./config-reference.md). It reads only standard terminal
signals:

| Variable | Effect |
|---|---|
| `NO_COLOR` | Disables color. Outranks `FORCE_COLOR`. |
| `FORCE_COLOR`, `CLICOLOR_FORCE` | Force color when output is not a terminal. |
| `CI` | Not read by variant. Progress animation stops in CI because stderr is not a terminal. |

Color precedence, highest first: `--color <when>`, `--no-color`, `NO_COLOR`,
`FORCE_COLOR`/`CLICOLOR_FORCE`, then whether the output is a terminal.

## Exit codes and errors

| Code | Meaning |
|---|---|
| `0` | Success, including "nothing to analyze" (no changed files, no workspace, no logged prediction). |
| `1` | A reported failure: a `variant` error (below), a `workspace check` violation, or a failed `doctor` check. |
| `2` | An unexpected error. The stack trace is printed; please [file a bug](https://github.com/saintparish4/variant/issues). |

Errors go to stderr as a code, a message and, usually, a hint:

```
[CONFIG_ERROR] Task "test" not found in graph
  Hint: Run `variant doctor` to diagnose configuration issues.
```

| Code | Raised when |
|---|---|
| `CONFIG_ERROR` | The config is missing, invalid, or names a task that does not exist |
| `CYCLE_ERROR` | Tasks depend on each other in a cycle |
| `TASK_EXECUTION_ERROR` | A task's command exited non-zero. See [troubleshooting](./troubleshooting.md#8-a-failure-prints-ran-because--what-is-it-telling-me) for the `ran because:` block it carries. |
| `CACHE_ERROR` | The task cache cannot be read or written. Deleting `.variant/cache/` fixes it. |
| `GRAPH_ERROR` | The symbol index cannot be read or written. Deleting `.variant/graph/` fixes it. |
| `IMPACT_REPORT_ERROR` | `impact verify` was given a file that is not a Vitest or Jest JSON report |
| `CLI_USAGE` | An option value is invalid, such as a non-numeric `--concurrency` |

## Refs and diffs

Commands that take `--base <ref>` accept anything git resolves: a branch, a
tag, a SHA, `HEAD~3`. They do not compare the same things:

| Command | Changed files | "Before" content | "After" content |
|---|---|---|---|
| `impact`, `diff` | `git diff <ref>`: committed, staged and unstaged changes to tracked files. Untracked files are not included. | the file at `<ref>` | the working tree |
| `pr check`, `pr report` | `git diff <ref>...HEAD`: committed changes since the branch left `<ref>` | the file at `<ref>` | the working tree |

Three consequences:

- **`impact --base main` on a branch behind `main`** also reports whatever
  landed on `main` since you branched, because it compares against `main`'s
  tip. To see only your branch, pass the merge base:
  `--base "$(git merge-base main HEAD)"`.
- **In CI, fetch history and use a remote-tracking ref.** `actions/checkout`
  clones one commit by default and creates no local branch for the target, so
  use `fetch-depth: 0` and `--base origin/main`, not `--base main`. The
  [example workflows](../examples/github-actions) do both.
- **A ref that does not resolve is not an error.** `impact` prints
  `could not determine changed files` and exits 0. `pr check` and `pr report`
  report zero changed files and a `safe to skip build` verdict. Check that the
  ref exists (`git rev-parse --verify <ref>`) before trusting a verdict.

## What gets analyzed

- **Source files:** `.ts`, `.tsx`, `.mts` and `.cts`, excluding `.d.ts`,
  `node_modules/`, `.git/`, `.variant/` and `dist/` at the project root.
  Imports written with `.js`, `.mjs`, `.cjs` or `.jsx` extensions resolve to the
  TypeScript source.
- **Tests** (for `impact`): indexed files under a `__tests__/` directory, or
  named `*.test.*` / `*.spec.*`. A `.test.js` file is not indexed, so it is
  never counted.
- **Workspace packages:** from `pnpm-workspace.yaml` `packages:`, else
  `package.json` `workspaces`, else the directories `packages/*`, `apps/*` and
  `services/*`. A directory counts only if its `package.json` has a `name`.
  None of this needs a `variant.config.ts`.
- **Path aliases:** `compilerOptions.paths` from the root `tsconfig.json`,
  including `extends` chains. Per-package tsconfig files are not read.
- **Package `exports` maps** of workspace packages, including conditions and
  `*` patterns. A target in `dist/` is also looked for under `src/`, `lib/` and
  `source/`.

The [limitations](./impact-and-workspace.md#limitations) section explains what
static analysis cannot see.

---

## Change intelligence

### `impact`

```
variant impact [--base <ref>] [--json]
```

Predicts which test files a change requires. **Report-only:** nothing is
skipped, and the printed advice is to run the full suite. Each run appends its
prediction to `.variant/history/impact.jsonl`.

| Option | Default | Description |
|---|---|---|
| `--base <ref>` | `HEAD~1` | Ref to compare against. See [Refs and diffs](#refs-and-diffs). |
| `--json` | off | Print the full report, [shape here](./api.md#impact---json). |

Each changed file is classified:

| Classification | Meaning | Effect |
|---|---|---|
| `non-impacting` | Comments or whitespace only | Selects nothing |
| `internal` | An exported symbol's body changed, but no signature did | Selects every test that imports the file, directly or transitively |
| `breaking` | An exported signature changed, or an export was added or removed | Also propagates to dependents that import the changed names |
| `unanalyzed` | Not TypeScript (`.json`, `.css`, `.d.ts`, …) | Treated as changed; never silently skipped |

A change to `package.json`, a lockfile, `tsconfig*.json`, or a
`vitest`/`jest`/`playwright`/`vite` config selects every test.

The verdict: `build required` if any file is `breaking` or every test was
selected; `build recommended` if any file is `internal` or `unanalyzed`;
otherwise `safe to skip build`.

Confidence is the share of the import graph that resolved, lowered by 10 points
per note (an unresolved import, a dynamic `import()`, a test that may depend on
fixtures), with a floor of 30%. It is not a probability that skipping is safe.

Exits 0.

### `impact verify`

```
variant impact verify <report> [--head-sha <sha>] [--json]
```

Reconciles a logged prediction against what actually failed. `<report>` is a
Vitest `--reporter=json` or Jest `--json` output file. Prints how many failures
the prediction caught and how many it would have skipped (**false skips**), and
appends the counts to `.variant/history/reconciliation.jsonl`.

| Option | Default | Description |
|---|---|---|
| `--head-sha <sha>` | most recent prediction | Use the prediction made at this commit. Pass the full 40-character SHA: `"$(git rev-parse HEAD)"`. |
| `--json` | off | Print the reconciliation as JSON, [shape here](./api.md#impact-verify---json). |

> **Known issue in 0.2.0:** `--json` is taken by the parent `impact` command,
> so `impact verify` prints the human report whichever position it is given in.

Exits 0 whatever the reconciliation finds: the test run decides whether the
build fails. A file that is not a test report exits 1 with
`IMPACT_REPORT_ERROR`. If no prediction is logged, or none matches
`--head-sha`, it says so and exits 0.

### `diff`

```
variant diff <file> [--base <ref>]
```

Classifies one TypeScript file's change and lists the exported symbols that
changed.

| Option | Default | Description |
|---|---|---|
| `--base <ref>` | `HEAD~1` | Ref to compare against |

```
File:           packages/utils/src/price.ts
Base ref:       main
Classification: breaking       (exported API changed)
Confidence:     100%

Exported symbol changes:
  changed: formatPrice [signature]
```

Each changed symbol is tagged `signature` (a runtime-visible shape: parameters,
return type, value type), `type` (type-space only: interfaces, type aliases), or
`body` (implementation only). Exits 0.

### `pr check`

```
variant pr check [--base <ref>]
```

Classifies every `.ts`/`.tsx` file changed on the branch and rolls them into one
verdict: `build required` if any file is `breaking`, `build recommended` if any
is `internal`, else `safe to skip build`.

| Option | Default | Description |
|---|---|---|
| `--base <ref>` | `main` | Branch or ref the pull request targets. See [Refs and diffs](#refs-and-diffs). |

```
Base ref: main
Changed .ts files: 2

File classifications:
  breaking       packages/utils/src/price.ts  (~1 changed)
  non-impacting  packages/utils/src/slug.ts

Verdict: build required
```

The parenthesis counts exported symbols added (`+`), removed (`-`) and changed
(`~`). Exits 0 whatever the verdict.

### `pr report`

```
variant pr report [--base <ref>] [--markdown] [--output <file>]
```

The `pr check` result as an artifact: JSON by default, or markdown for a pull
request comment. [Both formats are documented here](./api.md#pr-report).

| Option | Default | Description |
|---|---|---|
| `--base <ref>` | `main` | As for `pr check` |
| `--markdown` | off | Markdown instead of JSON |
| `--output <file>` | stdout | Write to this path, relative to the current directory |

Exits 0.

### `workspace check`

```
variant workspace check [--json]
```

A CI gate: compares what each workspace package imports with what its
`package.json` declares (`dependencies`, `devDependencies` or
`peerDependencies`).

| Violation | Meaning |
|---|---|
| `undeclared-workspace-dep` | Imports a sibling package it does not declare |
| `undeclared-external-dep` | Imports a third-party package declared neither by the package nor at the workspace root |
| `cross-package-relative-import` | Reaches into a sibling through a relative path, bypassing its entry point. Reported even when the dependency is declared. |

Node built-ins and a package's imports of itself are exempt.

| Option | Default | Description |
|---|---|---|
| `--json` | off | Print `{ packagesChecked, violations }`, [shape here](./api.md#workspace-check---json) |

**Exits 1 when there is any violation**, with or without `--json`. With no
workspace packages found, it prints a message and exits 0.

---

## Task orchestration

These run the tasks defined in [`variant.config.ts`](./config-reference.md) as
a cached dependency graph. They are feature-frozen.

### `build`

```
variant build [-c <n>] [--affected] [--dry-run]
```

Runs the `build` task and everything it depends on. A task whose inputs hash
the same as its last successful run is a cache hit and does not run.

| Option | Description |
|---|---|
| `-c`, `--concurrency <n>` | Most tasks to run at once within a level of the graph |
| `--affected` | Only run tasks for workspace packages changed since `git.baseRef`, plus every package that depends on them. Others are reported as `SKIP`. |
| `--dry-run` | Print the plan without running anything |

### `run`

```
variant run <task> [-c <n>] [--dry-run]
```

Runs a named task and its dependencies. Same options as `build`, except
`--affected`. An unknown task name exits 1 with `CONFIG_ERROR`.

### `insight`

```
variant insight
```

Each task's last run time and duration, read from the local cache.

---

## Setup and diagnostics

### `init`

```
variant init
```

Writes `variant.config.ts` to the current directory. In a terminal, it asks
which tasks to configure, then a command and inputs for each, suggesting
defaults from your `package.json` scripts, package manager and framework. When
stdin is not a terminal, it writes a single `build` task without asking. If a
config already exists, it writes nothing.

### `doctor`

```
variant doctor
```

Checks the Node version (≥ 20), that a config exists and validates, and the
cache size (a warning above 500 MB). Exits 1 if any check fails.

```
[✓] Node v22.4.0 meets requirement ≥20
[✓] Config found: variant.config.ts
[✓] Config is valid
[✓] Cache directory is 0 MB
```

### `check`

```
variant check
```

Validates the config and the task graph (unknown `dependsOn` targets, cycles)
without running anything. Prints `Config and graph are valid.` or exits 1 with
the error.

### `env`

```
variant env
```

What variant detected:

```
Package Manager : npm
Runtime         : node (fallback: node)
Framework       : none detected
```

---

## Files variant writes

Everything lives under `.variant/` at the project root; add it to
`.gitignore`.

| Path | Written by | Contents |
|---|---|---|
| `.variant/graph/symbols.json` | `impact`, `workspace check` | Incremental index of every file's exports and imports, keyed by content hash. Safe to delete. |
| `.variant/history/impact.jsonl` | `impact` | One line per prediction, newest 1000 kept. [Record shape](./api.md#history-files). |
| `.variant/history/reconciliation.jsonl` | `impact verify` | One line of counts per reconciliation, newest 1000 kept. |
| `.variant/cache/cache.json` | `build`, `run` | Task input hashes and timings. The directory is `cache.directory` in the config. |

`init` writes `variant.config.ts`, and `pr report --output` writes the file you
name. Nothing else is written.
