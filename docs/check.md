# `variant check`

> Your tests pass. Would they notice if the code you just changed were wrong?

`variant check` mutates the lines you changed, runs your Vitest suite against
each mutation, and lists the mutations the tests did not notice. This page
covers what it needs, how to run it locally and in CI, how to read a result,
and what it cannot tell you.

## Supported

| | Supported and tested | Not supported |
|---|---|---|
| Node | 22, 24 | 20 and older |
| Test runner | Vitest 4.1, one config, threads pool (the default) | Jest, Vitest browser mode |
| Code | TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`) | JavaScript, declaration files |
| Layout | Run from the package directory | A workspace root (it stops and says so) |
| OS | Linux, macOS, Windows | |

The mutating and test running is done by
[StrykerJS](https://stryker-mutator.io/) 10 and its Vitest runner, installed
with variant. You don't configure Stryker: variant passes its own settings and
ignores any Stryker config in the project.

## Run it

From the package whose code you changed:

```bash
npx @blzsky/variant check
```

`check` is not published yet; until the next release, run it from a build of
this repository with `node /path/to/variant/dist/cli.js check`.

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

4 mutations tried: 3 detected, 1 undetected.

Scope: the tests passed unmutated first (2 tests in 1 file, from the Vitest config here); each mutation then ran against the tests that executed its code; only comparisons, boolean conditions and arithmetic were mutated, and mutations are not type-checked.
Time: 3.6 s
```

### Flags

| Flag | Default | What it does |
|---|---|---|
| `--base <ref>` | detected | What to compare the working tree against |
| `--max-mutants <n>` | 50 | Mutations to run at most. The first *n* in a fixed order, so the same change reads the same twice |
| `--budget <time>` | `5m` | Stop after this long, the first test run included: `300`, `90s` or `5m` |
| `--vitest-config <file>` | Vitest's own lookup | The config to run the tests with |
| `--fail-on-survivors` | off | Exit 1 when a mutation went undetected or no test reached it, or the run is incomplete |
| `--json` | off | Print the result as JSON |

### What it compares against

In order:

1. `--base <ref>`, or the `VARIANT_BASE` environment variable.
2. On GitHub Actions: in a pull request, its merge base with the target branch;
   on a push, the commit the push replaced.
3. Uncommitted changes to tracked files: **HEAD**, so the change is your staged
   and unstaged edits.
4. A clean branch: the commit where it left the default branch.
5. Otherwise, a clean tree on the default branch: it stops with
   `NO_CHANGE_BASE` and asks for `--base`. It does not guess the previous
   commit.

Untracked files are not mutated: `git add` a new file to include it. They are
still copied, so an untracked test file does run.

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
3. Run the whole configured Vitest suite once, with no mutation, recording which
   tests execute which lines. If any test fails here, stop: `BASELINE_FAILED`.
4. For each mutation in the changed lines, run only the tests that executed
   that code.
5. Remove the copy, whether the run finished, stopped or failed.

A Vitest config that already uses the [Vitest adapter](./vitest-adapter.md)
works as is; the adapter is switched off inside a check.

`check` never runs Vitest in your working tree, and never writes there. While
it runs, `.variant/check-tmp/` exists and ignores itself in git. Vitest's
cache in `node_modules/.vite` is written to through the link, as an ordinary
test run would.

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
- **One Vitest project, from its package directory.** Not a workspace root,
  not Vitest browser mode, not Jest.
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
| `CHECK_BACKEND` | Stryker or Vitest could not run; its last output is shown |
| `GIT_REF_ERROR` | The base is not a commit in this clone (in CI: `fetch-depth: 0`) |

All exit 1.
