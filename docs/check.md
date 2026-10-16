# `variant check`

> Your tests pass. Would they notice if the code you just changed were wrong?

`variant check` mutates the lines you changed, runs your Vitest or Jest suite
against each mutation, and lists the mutations the tests did not notice. This page
covers what it needs, how to run it locally and in CI, how to read a result,
and what it cannot tell you.

## Supported

| | Supported and tested | Not supported |
|---|---|---|
| Node | 22, 24 | 20 and older |
| Test runner | Vitest 4.1 (tested in CI) and 5.0 (tried on 5.0.3, not in CI yet), one config, threads pool (the default) | Vitest browser mode |
| | Jest 30 (tested in CI) and 29.3 or newer (tried on 29.7), one config, the project's own transform (tried with babel-jest, ts-jest and `next/jest`) | A Jest config with `projects`; Jest before 29.3 |
| TypeScript | 5, 6 and 7 (on 7, a tsconfig `extends` outside the package is not adjusted for the copy) | |
| Code | TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`) | JavaScript, declaration files |
| Layout | Run from the package directory | A workspace root (it stops and says so) |
| OS | Linux, macOS, Windows | |

The mutating and test running is done by
[StrykerJS](https://stryker-mutator.io/) 10 and its Vitest and Jest runners,
installed with variant. You don't configure Stryker: variant passes its own settings and
ignores any Stryker config in the project.

## Run it

From the package whose code you changed:

```bash
npx @blzsky/variant check
```

`check` is published as a canary: install it with
`npm install -D @blzsky/variant@canary`.

```
Compared with HEAD (your staged and unstaged changes).

Mutated:
  src/discount.ts  4 changed lines, 4 mutations  (qualifiesForDiscount)

Not mutated:
  src/discount.test.ts  a test file

Undetected: 1
  src/discount.ts:3:9  in qualifiesForDiscount
    - total >= 100
    + total > 100
    Changing >= to > went undetected. Review the behavior at total = 100.

4 mutations run against the tests: 3 detected, 1 undetected.

Scope: the tests passed unmutated first (2 tests in 1 file, from the Vitest config here); each mutation then ran against the tests that executed its code; only comparisons, boolean conditions and arithmetic were mutated, and mutations are not type-checked.
Time: 3.6 s
```

### Flags

| Flag | Default | What it does |
|---|---|---|
| `--base <ref>` | detected | What to compare the working tree against |
| `--max-mutants <n>` | 50 | Mutations to run against the tests at most: the first *n* in a fixed order, so the same change reads the same twice. Mutations in code no test executes run no tests and are always listed |
| `--budget <time>` | `5m` | Stop after this long, the first test run included: `300`, `90s` or `5m` |
| `--runner <name>` | detected | `vitest` or `jest`: see [Which runner](#which-runner) |
| `--vitest-config <file>` | Vitest's own lookup | The Vitest config to run the tests with, inside the package |
| `--jest-config <file>` | Jest's own lookup | The Jest config to run the tests with, inside the package |
| `--fail-on-survivors` | off | Exit 1 when a mutation went undetected or no test reached it, or the run is incomplete |
| `--json` | off | Print the result as JSON |

### What it compares against

In order:

1. `--base <ref>`, or the `VARIANT_BASE` environment variable.
2. On GitHub Actions: in a pull request, its merge base with the target branch;
   on a push, the commit the push replaced.
3. Uncommitted changes, new files included: **HEAD**, so the change is your
   staged and unstaged edits and the files you have not added yet.
4. A clean branch: the commit where it left the default branch.
5. Otherwise, a clean tree on the default branch: it stops with
   `NO_CHANGE_BASE` and asks for `--base`. It does not guess the previous
   commit.

A new file git does not track yet (and does not ignore) is mutated as a whole.
A changed file whose change the semantic differ finds to be only formatting or
comments is not mutated at all, so a reformatting commit reports nothing.

### Which runner

The package's own Vitest or Jest, found from its dependencies, config files and
`test` script. Where a package shows both, its `test` script decides, and where
that does not, Vitest. `--runner`, `--vitest-config` and `--jest-config`
override it; `--vitest-config` and `--jest-config` together are an error. A
config must be inside the package, because the tests run in a copy of it.

## Reading a result

| Section | Meaning |
|---|---|
| **Undetected** | The tests that ran all passed with this mutation in place. Each shows the exact change and what to review. |
| **No test reached** | No test executed this code, so no test could notice a change to it. |
| **Inconclusive** | The run timed out, the tests errored, or the code did not compile with the mutation. Neither detected nor undetected. |
| **Incomplete** | The run stopped at `--max-mutants`, the `--budget` or Ctrl-C. What finished is shown; what did not is not a result. |
| **All detected** | Every mutation tried was noticed by the tests that ran. Evidence that the tests check these lines; not proof the change is correct. |

A surviving mutation is something to look at, not a bug. Some mutations are
*equivalent*: `>=` and `>` behave the same where a value can never equal the
boundary. Decide whether the difference matters; if it does, add a test that
pins it.

There is no score. A percentage over a handful of mutations says less than the
mutations themselves.

## How it works

1. Find the change: the files that differ from the base, and the lines each
   changed (`git diff -U0`).
2. Copy the project into `.variant/check-tmp/` (everything but `node_modules`,
   which is linked, and `.git`). Your uncommitted changes go with it.
3. Run the whole configured test suite once, with no mutation, recording which
   tests execute which lines. If any test fails here, stop: `BASELINE_FAILED`.
4. For each mutation in the changed lines, run only the tests that executed
   that code, in the files that hold them.
5. Remove the copy, whether the run finished, stopped or failed.

A Vitest config that already uses the [Vitest adapter](./vitest-adapter.md)
works as is; the adapter is switched off inside a check.

`check` never runs your tests in your working tree, and never writes there.
While it runs, `.variant/check-tmp/` exists and ignores itself in git. Vitest's
cache in `node_modules/.vite` is written to through the link, as an ordinary
test run would; Jest's cache is kept in the copy and removed with it.

### With Jest

variant runs Jest with your config, and changes this much of it:

- Coverage, reporters and any results processor are off, so `collectCoverage`,
  a `coverageThreshold` or `jest-junit` neither writes a file nor fails the run.
- Watchman is off, and Jest's cache directory is inside the copy.
- Jest's guess at related tests is not used: the first run is the whole suite,
  and each mutation runs the tests measured to execute its code.

Also worth knowing:

- A `@jest-environment node` or `jsdom` comment in a test file works as is. A
  comment naming any other environment hides which tests execute which code:
  the first run then repeats without that measurement, every mutation runs
  against every test, and the report says so. Slower, not wrong.
- `globalSetup` runs for every mutation, not once.
- A `test` script that runs Jest with `--experimental-vm-modules` (ESM) has the
  flag passed on.
- Refused before any test runs, with `CHECK_RUNNER`: a config with `projects`
  (run it from one project, with that project's config), and a `rootDir` or
  `roots` outside the package.

## In CI

The base is detected on GitHub Actions. The checkout needs the history to
compare against:

```yaml
name: variant check

on:
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: npm ci
      - run: npx @blzsky/variant check --budget 10m
```

Advisory by default: the job passes whatever `check` finds, and the findings
are in the log. Add `--fail-on-survivors` to fail the job on them, and
`--json` to hand the result to another step. On other CI systems, set
`VARIANT_BASE` (for example `origin/main`) or pass `--base`.

## Limitations

- **Equivalent mutations are not filtered.** See [Reading a
  result](#reading-a-result).
- **Only comparisons, boolean conditions and arithmetic.** String and other
  literals, removed calls, removed statements and changed assignments are not
  mutated.
- **Deleted lines cannot be mutated.** A change that only removes code gets no
  mutation, and the report counts the lines.
- **Mutations are not type-checked.** One TypeScript would reject still runs.
- **Coverage is per test process.** A test that drives a CLI or a server in
  another process does not count as executing that code, so its mutations read
  as reached by no test.
- **Flaky tests can look like detection.**
- **One test project, from its package directory.** Not a workspace root, not
  Vitest browser mode, not a Jest config with `projects`.
- **A file whose path holds `{` or `}` is not mutated.** Stryker reads the path
  as a pattern and braces cannot be escaped there; the report lists the file
  and says why. `[id]`, `[...slug]` and `(group)` work.
- **Paths outside the package are not in the copy.** A `tsconfig` that
  `extends` a file above the package, or a test that reads one, can fail in the
  copy while passing in place: that is reported as a failing baseline, with a
  hint saying so.

## Errors

| Code | Meaning |
|---|---|
| `NO_CHANGE_BASE` | Nothing says what the change is. Pass `--base` |
| `BASELINE_FAILED` | Tests fail with no mutation; the failing tests are listed |
| `CHECK_WORKSPACE_ROOT` | Run from a workspace root; run it in the package |
| `CHECK_RUNNER` | No Vitest or Jest here, or a Jest setup `check` does not run (`projects`, tests outside the package); it says which |
| `CHECK_BACKEND` | Stryker or the test runner could not run; its last output is shown |
| `GIT_REF_ERROR` | The base is not a commit in this clone (in CI: `fetch-depth: 0`) |

All exit 1.
