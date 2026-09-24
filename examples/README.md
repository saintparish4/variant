# Examples

| Example | What it shows |
|---|---|
| [`monorepo/`](./monorepo) | A three-package npm workspace with real Vitest tests. The [tutorial](../docs/tutorial.md) runs every change-intelligence command against it. |
| [`github-actions/pr-report.yml`](./github-actions/pr-report.yml) | Classify each pull request and keep one sticky comment with the verdict up to date. |
| [`github-actions/workspace-check.yml`](./github-actions/workspace-check.yml) | Fail CI when a package imports a dependency it does not declare. |
| [`github-actions/impact-shadow.yml`](./github-actions/impact-shadow.yml) | Log a prediction, run the full suite anyway, and reconcile the two, building up the false-skip rate across runs. |

## Using the workflows

Copy a file into your repository's `.github/workflows/`. Each one assumes:

- the default branch is `main`; change the `push` trigger if yours differs;
- Node 22 on `ubuntu-latest`;
- for `impact-shadow.yml`, npm and Vitest; its header comment shows the Jest
  variant.

They run `npx --yes @blzsky/variant`, which fetches the latest release on each
run. variant is `0.x` and can break in a minor release, so pin a version for
reproducible CI: `npx --yes @blzsky/variant@0.2.0`.

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
