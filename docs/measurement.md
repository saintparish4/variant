# Measurement log

variant does not skip tests. It predicts which tests a change needs, and the
prediction is checked against a full run. This page is the running record of
those checks. Test skipping gets designed only if the numbers here meet the gate
below. The gate was fixed before any of them existed.

**Small N.** Everything below comes from repositories the maintainer owns or
replayed locally. It shows the pipeline running end to end. It is not yet
evidence about the false-skip rate.

## The gate

Test skipping is designed only when all of these hold:

| Requirement | Now |
|---|---|
| False skips under 0.5% of failed test files | 2 of 4 (see below) |
| At least 20 repositories reporting shadow results | 2 |
| At least 200 shadowed pull requests | 1 |
| At least 5 external repositories backtested | 0 |

A false skip is a test file that failed and that the prediction did not
select. Flaky failures count against variant. The threshold will not be revised
after seeing results.

## Results

Last updated 2026-10-06. The variant rows were measured on 2026-09-29 with
variant at `9e96901` (after 0.2.1); the pyra row on 2026-10-06 with 0.2.1 from
npm.

| Repository | Source | Runs | Runs with failures | Failed test files | False skips | Median skip | Select-all |
|---|---|---:|---:|---:|---:|---:|---:|
| variant | Commit replay, `9f6d9d5`…`9e96901` | 8 | 4 | 4 | 2, both already failing | 96.1% | 0 |
| variant | Logged prediction, `2e67f4f` (2026-09-18) | 1 | 0 | 0 | 0 | 0% | 1 |
| pyra | Shadow mode in CI, one pull request | 2 | 0 | 0 | 0 | 92.9% | 0 |

**The two false skips.** From `9f6d9d5` to `90fa0b5`, one test file,
`src/cli/render/__tests__/impact.test.ts`, failed at every commit. It depended
on the resolved color setting, passed locally and failed whenever `CI=true`,
until `f6fe750` pinned color off. Where a
commit touched the renderer, the prediction selected the test and the failure
was caught. At `515da93` and `90fa0b5`, commits that did not touch the
renderer, it was not selected. Those are the two false skips. In both cases the
test was already failing at the parent commit, so skipping would have hidden a
test that was already red, not a new break. They count toward the gate anyway:
it makes no exception for them. A test that breaks for reasons its imports
cannot show is exactly what static selection misses, and why the default branch
would keep running everything even with skipping on.

**The skip rate.** Across the 8 commits, the prediction would have run 52 of
the 614 test-file runs, about 137 s of 589 s of summed test-file time. The four
commits that changed only documentation or tests selected at most 2 files
each. The
rate is measured against the files Vitest actually ran. variant also counts
helpers under `__tests__/` and the example workspace's tests, which Vitest's
config excludes, so its own "of N" is about 10 files higher.

**Confidence.** 6 of 8 predictions resolved `high`, 2 `medium`, none `low`.

**pyra.** The first runs of the shadow workflow outside variant's own
repository: two pushes to one pull request, in a pnpm workspace where each
package runs its own Vitest. Neither run had a failing test, so they say
nothing about false skips. The predictions selected 0 and then 1 of the 7 test
files the suite ran. variant counted 11, because it also counts four files that
suite does not run: integration tests that need a database, and browser specs.
The skip rate above is measured against the 7. The workflow did not run there
as shipped; the changes it needed became
[`impact-shadow-workspace.yml`](../examples/github-actions/impact-shadow-workspace.yml),
and the same run found that 0.2.1 indexes each package's `node_modules`.

**What is missing.** Two repositories, both the maintainer's own, and no pull
request from anyone else. Four failures are not a rate. The next targets are
pinned in [`accuracy/targets.json`](../accuracy/targets.json).

## How these are produced

- **Commit replay** ([`accuracy/`](../accuracy/README.md)) checks out each of
  a repository's recent commits, predicts with `variant impact --base <parent>`,
  runs the suite its CI runs, and reconciles with `variant impact verify`. It
  runs locally, with no workflow to install.
- **Shadow mode** ([`impact-shadow.yml`](../examples/github-actions/impact-shadow.yml),
  or [`impact-shadow-workspace.yml`](../examples/github-actions/impact-shadow-workspace.yml)
  for a workspace that tests each package on its own) does the same in CI on
  every pull request and push, and uploads the counts as a
  `variant-reconciliation` artifact.

A commit history that is green at every commit contains almost no failures,
so replaying it says little about false skips. What it does show is the skip
rate, how often variant gives up and selects everything, and how confident the
graph resolution was. Failures come from pull requests in progress, which is
why shadow mode on real CI matters more than any replay.

## Add your repository

Add [`impact-shadow.yml`](../examples/github-actions/impact-shadow.yml) to your
CI. It changes nothing about your build. Every run uploads `reconciliation.jsonl`,
which holds counts, commit SHAs and base refs, and no file paths or source.
After a few weeks,
[share it in an issue](https://github.com/saintparish4/variant/issues/new?template=3.shadow_results.yml).
Every false skip reported becomes a bug report and a fix.
