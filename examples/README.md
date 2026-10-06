# Examples

| Example | What it shows |
|---|---|
| [`monorepo/`](./monorepo) | A three-package npm workspace with real Vitest tests. The [tutorial](../docs/tutorial.md) runs every change-intelligence command against it. |
| [`github-actions/pr-report.yml`](./github-actions/pr-report.yml) | Classify each pull request and keep one sticky comment with the verdict up to date. |
| [`github-actions/workspace-check.yml`](./github-actions/workspace-check.yml) | Fail CI when a package imports a dependency it does not declare. |
| [`github-actions/impact-shadow.yml`](./github-actions/impact-shadow.yml) | Log a prediction, run the full suite anyway, and reconcile the two, building up the false-skip rate across runs. |
| [`github-actions/impact-shadow-workspace.yml`](./github-actions/impact-shadow-workspace.yml) | The same for a pnpm workspace whose packages each run their own tests. Needs a release newer than 0.2.1. |

## Using the workflows

Copy a file into your repository's `.github/workflows/`. Each one assumes:

- the default branch is `main`; change the `push` trigger if yours differs;
- Node 22 on `ubuntu-latest`;
- for `impact-shadow.yml`, npm and one Vitest run at the repository root; its
  header comment shows the Jest variant;
- for `impact-shadow-workspace.yml`, pnpm, packages under `packages/` and
  `apps/`, and a `test` script in each tested package that runs Vitest
  directly.

Which shadow workflow fits depends on where the tests run. One test command at
the root writes one report: use `impact-shadow.yml`. A workspace where each
package runs its own suite writes one report per package: use
`impact-shadow-workspace.yml`, which passes them all to `impact verify`. A task
runner that restores results from a cache (Turborepo, Nx) writes no report for
a cache hit, so the run has nothing to reconcile; that workflow calls
`pnpm -r run test` directly for that reason.

Add `.variant/` and `report.json` to `.gitignore`. Both are written into the
working tree, and a formatter or linter that checks JSON will otherwise fail
on a `report.json` left behind by a local run.

They run `npx --yes @blzsky/variant`, which fetches the latest release on each
run. variant is `0.x` and can break in a minor release, so pin a version for
reproducible CI: `npx --yes @blzsky/variant@0.2.1`.

The two workflows that diff (`pr-report.yml`, `impact-shadow.yml`) check out
with `fetch-depth: 0` and pass the target branch as `origin/<branch>`. Both
matter: a shallow clone has no base commit to compare against, and
`actions/checkout` creates no local branch for the target. See
[Refs and diffs](../docs/cli-reference.md#refs-and-diffs) for what goes wrong
otherwise.

## Trying the starter workspace

```bash
cp -r examples/monorepo /tmp/acme
cd /tmp/acme
npm install
git init -b main && git add -A && git commit -m "initial"
```

Then follow the [tutorial](../docs/tutorial.md) from step 1.
