<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./public/new-dark-mode.png">
    <source media="(prefers-color-scheme: light)" srcset="./public/new-light-mode.png">
    <img alt="variant: know what changed. know what matters." src="./public/new-light-mode.png" width="560">
  </picture>
</p>

## What is variant?

variant tells you which tests a change in a TypeScript monorepo actually needs.
It reads the diff at the level of the syntax tree, not the line, classifies
each changed file by what it does to the file's exported surface, and follows
every test file's imports across workspace packages to see which ones reach the
change.

```bash
npx @blzsky/variant impact --base origin/main
```

<p align="center">
  <img alt="Running `variant impact --base main` after changing formatPrice's signature and documenting slugify: price.ts is breaking, slug.ts is non-impacting, 2 of 4 test files run" src="./docs/assets/impact.gif" width="840">
</p>

In that repository, `shop` and `blog` both depend on `utils`. A tool that works
from the package graph would run all four test files. variant follows the
imports: only `shop` reaches the changed `price.ts`, and a doc comment on
`slug.ts` selects nothing.

It does not skip anything. Every prediction is logged, and
`variant impact verify` checks it against the test run you did anyway,
counting each failure the prediction would have missed. That count, the
false-skip rate, is what has to be measured before skipping is worth turning
on, and it is the point of the project right now.

The same analysis powers `pr check`, which rolls a branch's changes into one
build verdict for a pull request comment, and `workspace check`, which fails CI
when a package imports something it never declared.

> **Status**: `0.x`, report-only. `impact`, `impact verify`, `diff`,
> `pr check`, `pr report` and `workspace check` work today and are where
> development happens. Test skipping is **not implemented**, deliberately, and
> will not be until the false-skip rate is measured on real repositories; see
> [Help measure it](#help-measure-it). The task runner underneath (`build`,
> `run`, `insight`) works but is frozen. Any minor release can break, and every
> break is in the [CHANGELOG](./CHANGELOG.md).

## Install

variant needs Node 20 or newer and a git repository with at least one commit
before the one you are checking. There is nothing to configure.

```bash
# run it once
npx @blzsky/variant impact --base origin/main

# keep it in a project
npm install -D @blzsky/variant    # or pnpm add -D / yarn add -D
```

The package is `@blzsky/variant`; the binary it installs is `variant`.
`npx variant` fetches an unrelated package, so always use the scope with `npx`.

### Upgrade

```bash
npm install -D @blzsky/variant@latest
```

Because variant is `0.x`, pin a version in CI (`npx --yes @blzsky/variant@0.2.1`)
and read the CHANGELOG before moving to a new minor version.

## Usage

```bash
variant impact --base origin/main          # which tests does this branch need?
npx vitest run --reporter=json --outputFile=report.json
variant impact verify report.json          # did the prediction miss a failure?
variant pr check --base origin/main        # one build verdict for the branch
variant workspace check                    # undeclared dependencies (exits 1)
```

| Command | What it does |
|---|---|
| `impact` | Predict which test files a change requires, and how much of the import graph resolved. Report-only. |
| `impact verify <report>` | Reconcile the last prediction against a Vitest or Jest JSON report and report false skips |
| `diff <file>` | Classify one file's change and list the exported symbols that changed |
| `pr check` | Classify every TypeScript change on the branch and roll them into one build verdict |
| `pr report` | The `pr check` verdict as JSON, or as markdown for a PR comment |
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

Check out with `fetch-depth: 0` and pass `--base origin/<branch>`. A shallow
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

### Help measure it

A false skip is a test that failed and that the prediction did not select. The
false-skip rate is false skips divided by failed test files, with flaky
failures counted against variant. One repository is not enough to trust it.

If you add `impact-shadow.yml` to your CI, it changes nothing about your build.
It uploads the counts as a `variant-reconciliation` artifact: commit SHAs,
branch names and numbers, no file paths and no source.
[Share them in an issue](https://github.com/saintparish4/variant/issues/new?template=3.shadow_results.yml),
and they go into the measurement that decides whether skipping ever ships.

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
  string-keyed registries, computed `require()` and `eval` never appear as
  imports. A test that reaches code only this way is not selected, and nothing
  in the output says so. This is the largest blind spot.
- **Service boundaries end the graph.** An end-to-end test that calls a running
  server imports none of the code it exercises.
- **Setup files are recognized by name.** `vitest.setup.ts`, `setupTests.ts`,
  `global-setup.ts` and the like select every test; a setup file named
  anything else selects none. variant does not read the runner config.
- **Fixtures, snapshots and non-TypeScript assets** a test reads at runtime are
  outside its import closure. Unresolved imports lower the confidence score and
  add a note, but the missing edges stay missing.
- **Dynamic `import()` is assumed to use everything.** The change propagates
  and a note is printed; the run gets wider, not narrower.
- **Type-only changes are not narrowed.** Changing an interface selects every
  test that imports the file, though no runtime behavior changed.
- **The confidence score is not a safety number.** It says how much of the
  import graph resolved. Only the false-skip rate says how safe a skip would
  have been.

The full list, with how each case is handled, is in
[Impact & workspace](./docs/impact-and-workspace.md#limitations).

## Documentation

| | |
|---|---|
| [Tutorial](./docs/tutorial.md) | Every command, step by step, on a sample monorepo |
| [Getting started](./docs/getting-started.md) | Run it on your own repository, then set up the task runner |
| [Impact & workspace](./docs/impact-and-workspace.md) | How `impact` and `workspace check` work, and what static analysis cannot see |
| [PR commands](./docs/pr-commands.md) | `pr check` and `pr report` |
| [CLI reference](./docs/cli-reference.md) | Every command, flag, exit code and file |
| [API reference](./docs/api.md) | `defineConfig`, the config types, and every JSON output |
| [Monorepo setup](./docs/monorepo.md) | Workspace tasks and `--affected` |
| [Config reference](./docs/config-reference.md) | Every `variant.config.ts` key |
| [Troubleshooting](./docs/troubleshooting.md) | Common problems and what they mean |

## Contributing

See [CONTRIBUTORS.md](./CONTRIBUTORS.md) to set up the repository, run the
tests, and check a change before opening a pull request.

## License

MIT — see [LICENSE](./LICENSE).
