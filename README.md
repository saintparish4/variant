<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./public/new-dark-mode.png">
    <source media="(prefers-color-scheme: light)" srcset="./public/new-light-mode.png">
    <img alt="variant: know what changed. know what matters." src="./public/new-light-mode.png" width="560">
  </picture>
</p>

## What is variant?

variant answers one question about a change to a TypeScript repository: what
has to be verified before this is safe to merge?

It reads the diff at the level of the syntax tree, not the line, follows every
import across workspace packages, and says, on the pull request:

- how risky each changed file is, and why;
- which test files reach the change, with the import chain from each test to
  the file that changed;
- which typecheck, build and lint commands apply to the packages it affects;
- which changed files no test reaches at all.

You set it up once. After that nobody types a variant command: your own test
command and your pull requests are the interface.

```bash
npx @blzsky/variant init
```

`init` finds out how the repository installs, tests and runs CI, shows every
change it would make as a diff, and makes them when you agree. It adds one
line to your Vitest config and one workflow that keeps a comment on each pull
request.

It does not skip tests. Your full suite runs as it always did; in CI variant
predicts beside it which test files the change needs, then checks that
prediction against what failed and prints one line:

```
variant: predicted 8 of 55 test files (high). 2 failed, all predicted.
```

Leaving tests out is something variant has to earn in each repository, from
that record, and is not built yet.

> **Status**: `0.x`. What is described here is on the default branch and
> **not in a published release yet**: npm still serves 0.2.1, which has
> `impact`, `pr check`, `pr report` and `workspace check`, an `init` that
> only writes a task-runner config, and no adapter. Until the next release,
> the commands on this page do something else there. The adapter is for Vitest; a Jest repository gets the pull
> request report only. Test skipping is **not implemented**, deliberately.
> The task runner underneath (`build`, `run`, `insight`) works but is frozen.
> Any minor release can break, and every break is in the
> [CHANGELOG](./CHANGELOG.md).

## Install

variant needs Node 20 or newer and a git repository.

```bash
npx @blzsky/variant init            # shows the changes, asks, then applies
npx @blzsky/variant init --dry-run  # only look
```

`init` installs `@blzsky/variant` as a dev dependency with your package
manager (npm, pnpm, Yarn or Bun), adds the
[Vitest adapter](./docs/vitest-adapter.md) to your test config, ignores
`.variant/`, gives your test workflow's checkout the history a prediction
needs, and writes `.github/workflows/variant.yml`. Anything it cannot edit
with confidence it leaves alone and tells you the lines to add.

The package is `@blzsky/variant`; the binary it installs is `variant`.
`npx variant` fetches an unrelated package, so always use the scope with `npx`.

### Upgrade

```bash
npm install -D @blzsky/variant@latest
```

Because variant is `0.x`, read the CHANGELOG before moving to a new minor
version.

## Usage

After `init` there is nothing to run. What you see:

- **On every pull request**, one comment, kept up to date: the risk of each
  changed file, the tests to run and why, the checks, and what is not
  verified. [An example](./docs/api.md#pr-report).
- **In every CI test run**, one line saying what was predicted and whether a
  failure fell outside it.

The first runs after setup select every test, because the setup itself changes
the lockfile and the test config. Narrowed predictions start with the next
pull request.

The commands underneath are still there when you want them:

```bash
variant pr report --markdown               # the pull request comment, locally
variant impact                             # which tests does this change need?
variant workspace check                    # undeclared dependencies (exits 1)
```

<p align="center">
  <img alt="Running `variant impact --base main` after changing formatPrice's signature and documenting slugify: price.ts is breaking, slug.ts is non-impacting, 2 of 4 test files run" src="./docs/assets/impact.gif" width="840">
</p>

| Command | What it does |
|---|---|
| `impact` | Predict which test files a change requires, and how much of the import graph resolved. Report-only. |
| `impact verify <report...>` | Reconcile the last prediction against one or more Vitest or Jest JSON reports and report false skips |
| `diff <file>` | Classify one file's change and list the exported symbols that changed |
| `init` | Set a repository up: the dependency, the adapter, the workflow. Once. |
| `pr check` | Classify every TypeScript change on the branch and roll them into one build verdict |
| `pr report` | What the branch changes and what has to be verified, as JSON or as markdown for a PR comment |
| `workspace check` | Fail when a package imports a dependency it does not declare |

Run `variant <command> --help` for its flags, or see the
[CLI reference](./docs/cli-reference.md). The [tutorial](./docs/tutorial.md)
walks through every command on a sample monorepo in about fifteen minutes.

Every changed file gets one of three classifications. `non-impacting` means
only comments or formatting changed, and selects no tests. `internal` means the
body changed but the exported surface did not, and selects every test that
imports the file. `breaking` means an exported signature changed, and also
follows the importers of the changed names for `pr check`'s verdict. A change
to `package.json`, a lockfile, `tsconfig*.json`, a test runner config or a test
setup file selects every test.

### In CI

`init` writes what CI needs. To wire the commands in by hand: check out
with `fetch-depth: 0`; the base is detected on GitHub Actions, and elsewhere
pass `--base origin/<branch>`. A shallow
clone has no base commit to compare against, and `actions/checkout` creates no
local branch for the target; variant stops with `GIT_REF_ERROR` rather than
guess.

Ready-to-copy GitHub Actions workflows are in
[`examples/github-actions`](./examples/github-actions):

- [`pr-report.yml`](./examples/github-actions/pr-report.yml) keeps one sticky
  comment with the verdict on every pull request.
- [`workspace-check.yml`](./examples/github-actions/workspace-check.yml) fails
  the build on an undeclared dependency.
- [`impact-shadow.yml`](./examples/github-actions/impact-shadow.yml) logs a
  prediction, runs the full suite anyway, and reconciles the two.
- [`impact-shadow-workspace.yml`](./examples/github-actions/impact-shadow-workspace.yml)
  does the same for a pnpm workspace that tests each package on its own. It
  needs a release newer than 0.2.1.

### Help measure it

A false skip is a test that failed and that the prediction did not select. The
false-skip rate is false skips divided by failed test files, with flaky
failures counted against variant. One repository is not enough to trust it.

If you add `impact-shadow.yml` to your CI, it changes nothing about your build.
It uploads the counts as a `variant-reconciliation` artifact: commit SHAs,
branch names and numbers, no file paths and no source.
[Share them in an issue](https://github.com/saintparish4/variant/issues/new?template=3.shadow_results.yml),
and they go into the measurement that decides whether skipping ever ships. The
[measurement log](./docs/measurement.md) has every number collected so far.

## Benchmarks

Measured by CI on 2026-09-28 with [`benchmarks/bench.mjs`](./benchmarks/bench.mjs),
on a generated git repository of 300 TypeScript files with 25 changed. Each
number is the median of the runs shown. Machine: AMD EPYC 9V74 (4 cores),
16 GB RAM, Linux, Node 22.23.2, hyperfine 1.18.0.

| | Median | Runs |
|---|---:|---:|
| `variant --help` (startup) | 36.7 ms | 20 |
| `variant impact`, 25 changed files of 300 | 988 ms | 10 |

- **Startup is a CI gate.** The benchmark workflow fails when the `--help`
  median passes 200 ms, because every command is loaded only when it runs.
- **The symbol index is cached.** `.variant/graph/symbols.json` keeps each
  file's exports and imports keyed by content hash, so a later run re-parses
  only the files whose content changed.
- **Large real repositories are not measured yet.** 300 generated files say
  how the pipeline behaves, not what it costs on your monorepo. Whether the
  analysis pays for itself depends on how long your suite takes, and that
  number has to come from real runs.

Reproduce with `pnpm build && pnpm bench`; the methodology is in
[`benchmarks/README.md`](./benchmarks/README.md).

## How it compares

**Nx `affected`, Turborepo `--filter`.** These work at the level of projects
and tasks: a change inside `utils` reruns the test target of `utils` and of
every project that depends on it. In the example above, that is all four test
files. variant works at the level of test files and follows each one's imports
across packages, so it runs two. Nx and Turborepo also cache and orchestrate
tasks; variant's `impact` does neither, and the two can be used together.

**`vitest related`, `jest --findRelatedTests`.** These follow imports at the
file level too, within one project. variant adds two things: import chains that
cross workspace packages, and classification, so a change to comments or
formatting selects no tests at all.

**Not function-level.** Test selection is by file: a test that imports a changed
file runs, whichever functions it calls. The exported-surface classification
decides `pr check`'s build verdict and whether a change selects anything, not
which functions a test touches.

## Limitations

Worth knowing before you trust a prediction. variant reads source statically,
so it sees imports and nothing else. It widens the selection or lowers its
confidence wherever it can tell it is missing something, but some edges it
cannot see at all:

- **Runtime-only wiring is invisible.** Dependency injection by token,
  string-keyed registries and `eval` never appear as imports. A test that
  reaches code only this way is not selected, and nothing in the output says
  so. This is the largest blind spot.
- **Service boundaries end the graph.** An end-to-end test that calls a running
  server imports none of the code it exercises.
- **Setup files are recognized by name.** `vitest.setup.ts`, `setupTests.ts`,
  `global-setup.ts` and the like select every test; a setup file named
  anything else selects none. variant does not read the runner config.
- **Files read at runtime are outside the closure.** A changed stylesheet or
  JSON file that a TypeScript file imports selects that file's tests, but a
  fixture, snapshot or asset a test reads with `fs` is invisible. A changed
  file that reaches no test is listed as `Unreached`.
- **Only the directory it runs in is indexed.** A file changed elsewhere in
  the repository selects the tests of the files that import it by relative
  path, and is listed as `Unreached` otherwise.
- **Unreached is not the same as untested.** A changed file no test reaches
  is listed as `Unreached` and the prediction reads `low`. variant cannot tell
  an untested file from one a runtime lookup uses.
- **JavaScript is indexed when git says it is yours.** Tracked or new
  `.js`, `.jsx`, `.mjs` and `.cjs` files are read like TypeScript; build
  output and bundles are not. A changed CommonJS module reaches everything
  that requires it.
- **Computed imports are followed only as far as their literal start.**
  `` import(`./locales/${lang}.js`) `` reaches everything under `./locales/`;
  `import(name)` could load anything, and is a standing note on every run.
- **Dynamic `import()` is assumed to use everything.** The change propagates
  and a note is printed; the run gets wider, not narrower.
- **Workspace discovery can miss a package**, and a bare import of a package it
  missed counts as external. `impact` prints how many packages it found and
  notes imports no discovered package or manifest accounts for.
- **Type-only changes are not narrowed.** Changing an interface selects every
  test that imports the file, though no runtime behavior changed.
- **The confidence score is not a safety number.** It says how much of the
  import graph resolved, as `high`, `medium` or `low` and a percentage. Only
  the false-skip rate says how safe a skip would have been.

The full list, with how each case is handled, is in
[Impact & workspace](./docs/impact-and-workspace.md#limitations).

## Documentation

| | |
|---|---|
| [Tutorial](./docs/tutorial.md) | Every command, step by step, on a sample monorepo |
| [Getting started](./docs/getting-started.md) | Run it on your own repository, then set up the task runner |
| [Impact & workspace](./docs/impact-and-workspace.md) | How `impact` and `workspace check` work, and what static analysis cannot see |
| [PR commands](./docs/pr-commands.md) | `pr check` and `pr report` |
| [Vitest adapter](./docs/vitest-adapter.md) | One config line in place of the commands: predict and check on every test run |
| [CLI reference](./docs/cli-reference.md) | Every command, flag, exit code and file |
| [API reference](./docs/api.md) | `defineConfig`, the config types, and every JSON output |
| [Monorepo setup](./docs/monorepo.md) | Workspace tasks and `--affected` |
| [Config reference](./docs/config-reference.md) | Every `variant.config.ts` key |
| [Troubleshooting](./docs/troubleshooting.md) | Common problems and what they mean |
| [Measurement log](./docs/measurement.md) | Every prediction checked against a full run so far, and the gate skipping has to pass |

## Contributing

See [CONTRIBUTORS.md](./CONTRIBUTORS.md) to set up the repository, run the
tests, and check a change before opening a pull request.

## License

MIT — see [LICENSE](./LICENSE).
