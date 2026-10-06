# Accuracy

Shadow mode, replayed over real history. `impact-shadow.yml` measures a repository going forward, one pull request at a time; this measures its past, commit by commit, with no workflow to install.

## Run it

```bash
pnpm build                          # predictions come from dist/cli.js
pnpm accuracy                       # every target in targets.json
node accuracy/replay.mjs --target pyra
node accuracy/replay.mjs --work-dir /data/variant-accuracy
```

Clones are cached in the work dir (default `$TMPDIR/variant-accuracy/<target>`) and reused across runs. Results go to `accuracy/results/`, which is gitignored:

- `<target>.json`: every commit's row and the target's summary;
- `<target>.reconciliation.jsonl`: the same records `impact verify` writes, in the format the [shadow-results issue form](../.github/ISSUE_TEMPLATE/3.shadow_results.yml) takes;
- `latest.md`: one table per target, regenerated from every `<target>.json` present.

## What it does

For each target, the last `commits` first-parent commits up to the pinned `sha`, oldest first:

1. Check the commit out on a clean tree and run `variant impact --base <parent> --json`. The prediction comes before install and build, so nothing they write can join the diff.
2. Install when the lockfile changed since the last install, then run `setup` (a build, when the tests need one).
3. Run `test`: the suite the repository's CI runs, with Vitest writing `.vitest-report.json` in each package it runs in. The reports are merged into one.
4. Run `variant impact verify <report> --head-sha <commit> --json`, as the shadow workflow does.

Every target is predicted by the same build of variant, the one in this checkout. `.variant/graph` survives between commits, as a CI cache would keep it, and `.variant/history` is cleared at the start of each target so the results hold this run only.

A commit that cannot be replayed (the prediction errors, install or build fails, or the suite writes no report) is listed with the reason and left out of every total.

## Reading the numbers

- **False skips** are failing test files the prediction did not select. This is the number the skip-mode gate is about.
- **A green history measures almost nothing about false skips.** Commit replay can only count failures that were committed, and most commits pass. What it does measure well is the skip rate, the select-all rate, the confidence distribution, and whether the pipeline runs at all on a repository variant has never seen. Mutation replay, which breaks each commit's changed files on purpose and checks that the prediction selected every test that then fails, is the planned answer and is not built yet.
- **Skip rate is measured against what the runner ran.** `Of` counts the test files variant indexed; `Runner ran` counts the files the runner reported, and `Would run` how many of those the prediction selected. The two counts differ both ways. variant counts every file under `__tests__/` as a test, as Jest does, so helpers and fixtures there inflate `Of`, as do test files the runner config excludes. The other way round, a runner file variant does not index (`*.test-d.ts`, `.js` tests) is never selected, so every failure in one is a false skip.
- **Test-file time** sums each test file's duration. Runners overlap files across workers, so it estimates the test time a skip would save, not wall-clock minutes.
- **Already failing** marks a false skip of a file that also failed at the parent commit, in the same replay. Skipping it would have hidden a test that was already red, not a new break. It still counts toward the gate, which makes no such exception.
- Flaky failures are counted as they happened, against variant. Nothing is rerun.

## Targets

`targets.json` pins each repository to an exact SHA, so a run is reproducible until the pin moves. Moving a pin is a deliberate change, recorded in the commit that makes it.

| Field | Meaning |
|---|---|
| `name` | Results file name and `--target` value |
| `repo` | Anything `git clone` accepts |
| `sha` | The newest commit replayed |
| `commits` | How many first-parent commits to replay, ending at `sha` |
| `install` | Run when the lockfile changes |
| `setup` | Run on every commit, after install |
| `test` | The full suite, writing `.vitest-report.json` per Vitest process |

Only Vitest reports are read today; Jest's `--json --outputFile` shape is the same, so a Jest target needs only its report written under the same name.

## Caveats

- The replay runs each target's install scripts and test suite on your machine. Read a target's repository before adding it.
- Under WSL2, keep the work dir on the Linux filesystem (the default). A clone under `/mnt/c` makes installs and suites several times slower.
- Old commits can fail to install: registries drop versions, engines move. Those rows say so and are excluded; they are not counted as passes.
