# Vitest adapter

One line in your Vitest config. After that your normal test command predicts
which tests a change needs and checks the prediction against what happened,
with no variant command typed by anyone.

Not in a published release yet.

## Setup

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import variant from "@blzsky/variant/vitest";

export default defineConfig({
	test: {
		reporters: ["default", variant()],
	},
});
```

Add `.variant/` to `.gitignore`. In CI, check out with `fetch-depth: 0`, so the
commit to compare against is there.

## What it does

1. **When the tests start,** it starts `variant impact` in a separate process.
   The two run side by side: nothing is skipped, so the tests do not wait for
   the prediction.
2. **The tests run** exactly as they would without it.
3. **When they end,** it compares the test files that failed with the ones
   that were predicted, prints one line, and appends one record to
   `.variant/history/reconciliation.jsonl`.

```
variant: predicted 8 of 55 test files (high). 2 failed, all predicted.
```

When a failing test file was not predicted, it is named:

```
variant: predicted 8 of 55 test files (high). 2 failed, 1 NOT predicted:
  src/billing/invoice.test.ts
  Nothing was skipped. This is a false skip; please report it.
```

On GitHub Actions the same line is added to the job summary.

## What it will not do

- **Skip a test.** It reports; every test you asked for runs.
- **Change the result of a run.** It never sets an exit code. If variant itself
  fails, the adapter prints `variant: skipped (<reason>)` and nothing else.
- **Hold a run up for long.** If the prediction has not finished 30 seconds
  after the tests do, it is abandoned.
- **Run in watch mode,** or reconcile a run that was interrupted.

## When it runs

In CI, which it recognises by the `CI` environment variable. Locally it is off
unless you ask: a local run is often one file, which makes a poor comparison
and a line of output nobody asked for.

| Setting | Effect |
|---|---|
| `variant({ local: true })` | Run outside CI too |
| `VARIANT_SHADOW=1` | The same, from the environment |
| `VARIANT_SHADOW=0` | Off everywhere, CI included |
| `variant({ silent: true })` | Record without printing |
| `variant({ timeoutMs: 60000 })` | Wait longer for the prediction once the tests end |

## What it compares against

No flags are needed. The base is worked out the way `variant impact` does it:
the merge base with the target branch in a GitHub Actions pull request, the
commit a push replaced, or `VARIANT_BASE` on another CI system. See
[Refs and diffs](./cli-reference.md#refs-and-diffs).

## One test process per package

A workspace that runs one Vitest per package (`pnpm -r test`, Turborepo, Nx)
starts the adapter once in each. One of them makes the prediction, for the
whole repository, and the others use it. Each records the test files it ran
itself, so a run produces one record per process; the counts add up.

A task that a build cache restores does not run its tests, so the adapter does
not run and there is no record for it. Nothing ran, so there is nothing to
compare.

## Requirements

Vitest 3 or newer. The prediction is made from the top of the git repository
and stored in `.variant/` there.
