# Tutorial: follow a change through a monorepo

In about fifteen minutes you will run every change-intelligence command against
a small three-package workspace: watch a comment select zero tests, watch a
breaking change select exactly the tests it can reach, check that prediction
against a real test run, and catch an undeclared dependency.

Everything below was run against the published `@blzsky/variant`; the output
blocks are what it printed. Commands are for a POSIX shell (on Windows, use Git
Bash or WSL). You need Node ≥ 20, npm, and git ≥ 2.28.

## 0. Set up the starter workspace

The starter lives in this repository at [`examples/monorepo`](../examples/monorepo).
Copy it somewhere outside the clone and make it a repository of its own:

```bash
git clone --depth 1 https://github.com/saintparish4/variant.git
cp -r variant/examples/monorepo acme
cd acme
npm install
git init -b main
git add -A
git commit -m "initial"
```

`npm install` brings in Vitest and `@blzsky/variant` itself, so `npx
@blzsky/variant` runs the local copy from here on.

The workspace has three packages. Both `shop` and `blog` depend on `utils`, but
each imports a different file from it:

```
packages/
  utils/src/price.ts   formatPrice()    price.test.ts
  utils/src/slug.ts    slugify()        slug.test.ts
  shop/src/cart.ts     imports @acme/utils/price    cart.test.ts
  blog/src/post.ts     imports @acme/utils/slug     post.test.ts
```

A tool that decides "affected" from the package graph sees a change anywhere in
`utils` and runs all four test files. variant follows the imports themselves.

## 1. A change that changes nothing

Work on a branch, the way you would for a pull request:

```bash
git switch -c feat/currency
```

Add a doc comment to `packages/utils/src/slug.ts`, and commit it:

```ts
/** Lowercase a title and join its words with hyphens, for use in URLs. */
export function slugify(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
```

```bash
git commit -am "docs: document slugify"
npx @blzsky/variant impact --base main
```

```
Base ref: main

You changed 1 file.
  non-impacting  packages/utils/src/slug.ts

Impact: 0 files

Run:   0 test files
Skip:  4 test files (of 4 total)

Verdict:    safe to skip build
Confidence: 100%  (report-only — run the full suite; skipping unlocks after shadow-mode validation)
```

`non-impacting` means no exported surface and no code changed. There is nothing
for a test to observe, so no test is selected. A plain `vitest related` would
select both `slug.test.ts` and `post.test.ts` here, because it only knows that
the file changed.

## 2. A breaking change

Make `formatPrice` take a currency. Replace `packages/utils/src/price.ts` with:

```ts
export function formatPrice(cents: number, currency: string): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
		cents / 100,
	);
}
```

```bash
git commit -am "feat: format prices in any currency"
npx @blzsky/variant impact --base main
```

```
Base ref: main

You changed 2 files.
  breaking       packages/utils/src/price.ts  (formatPrice)
  non-impacting  packages/utils/src/slug.ts

Impact: 4 files, 2 packages (@acme/shop, @acme/utils)

Run:   2 test files
Skip:  2 test files (of 4 total)

Verdict:    build required
Confidence: 100%  (report-only — run the full suite; skipping unlocks after shadow-mode validation)
```

Reading it:

- **`breaking (formatPrice)`**: an exported signature changed. The parenthesis
  names the symbols a dependent would have to import for the change to reach it.
- **Impact** is the blast radius: `price.ts`, `cart.ts` (which imports
  `formatPrice`), and their tests, across two packages. `@acme/blog` depends on
  `@acme/utils` but is not in it.
- **Run / Skip**: `price.test.ts` and `cart.test.ts` run. `slug.test.ts` and
  `post.test.ts` are skipped: no import chain from either reaches `price.ts`.
- **Test selection follows imports, not names.** Had this been a body-only
  (`internal`) change, `cart.test.ts` would still be selected, because it
  imports `price.ts` and a new implementation can change what the test sees.
- **Confidence** is how much of the import graph resolved. It is not a safety
  number. Here every import resolved.

`--json` prints the same report with every affected file and note; the shape is
in the [API reference](./api.md#impact---json).

## 3. Check the prediction against reality

`impact` is report-only: it never skips anything. Each prediction is appended to
`.variant/history/impact.jsonl` so it can be checked against a real run. Run the
whole suite, keeping Vitest's JSON report:

```bash
npx vitest run --reporter=json --outputFile=report.json
```

Vitest exits 1: `price.test.ts` and `cart.test.ts` fail, because `formatPrice`
now needs a currency. Reconcile:

```bash
npx @blzsky/variant impact verify report.json
```

```
Prediction: 2026-09-24T22:31:53.432Z (4c2c3d04fe8774b96de5b961ee56ba59d1599a9a)
Matched by: most recent — verify this is the right run

Predicted:  2 of 4 test files
Failed:     2 test files

Caught:      2 (inside the predicted set)
False skips: 0 (would have been missed)

False-skip rate this run: 0.0%
One run is not a rate. Reconcile many before reading anything into it.
```

A **false skip** is a test that failed but was not predicted. Had skipping been
on, that failure would have shipped. Both failures here were inside the
prediction.

Each reconciliation is appended to `.variant/history/reconciliation.jsonl`, so
the rate builds up across runs. In CI, pass `--head-sha "$(git rev-parse HEAD)"`
to match the prediction made for that exact commit;
[`impact-shadow.yml`](../examples/github-actions/impact-shadow.yml) wires this
up.

## 4. The same change as a pull-request verdict

`pr check` classifies every committed TypeScript change on the branch since it
left `main`, and rolls them into one verdict:

```bash
npx @blzsky/variant pr check --base main
```

```
Base ref: main
Changed .ts files: 2

File classifications:
  breaking       packages/utils/src/price.ts  (~1 changed)
  non-impacting  packages/utils/src/slug.ts

Verdict: build required
```

`pr report` renders it for a PR comment:

```bash
npx @blzsky/variant pr report --base main --markdown --output pr-report.md
```

```markdown
## Variant PR Report

**Generated:** 2026-09-24T22:31:58.071Z
**Base ref:** `main`

### Semantic Diff

🔴 **Build required**

| File | Classification | API Changes |
|------|----------------|-------------|
| `packages/utils/src/price.ts` | breaking | ~1 |
| `packages/utils/src/slug.ts` | non-impacting | — |
```

[`pr-report.yml`](../examples/github-actions/pr-report.yml) posts this as one
sticky comment that each push updates.

## 5. Catch an undeclared dependency

Give the shop a link to a blog post. Create `packages/shop/src/product.ts`:

```ts
import { postUrl } from "@acme/blog";

export function productStoryUrl(name: string): string {
	return postUrl(`The story behind ${name}`);
}
```

This runs fine: npm links every workspace package into the root
`node_modules`, so `@acme/blog` resolves. But `@acme/shop` never declared it,
and it breaks the day the packages are installed or published separately.

```bash
npx @blzsky/variant workspace check
```

```
Checked 3 packages.

  ✗ @acme/shop imports @acme/blog but does not declare it
      packages/shop/src/product.ts

1 violation found.
```

It exits 1, so it fails CI. Declare the dependency in
`packages/shop/package.json`:

```json
"dependencies": {
  "@acme/blog": "*",
  "@acme/utils": "*"
}
```

```bash
npx @blzsky/variant workspace check
```

```
Checked 3 packages.

No dependency violations found.
```

## What you have seen

| Command | Answered |
|---|---|
| `impact` | Which tests this change can reach, and how much of the graph resolved |
| `impact verify` | Whether the prediction missed a failing test |
| `pr check` / `pr report` | One build verdict for the branch, for humans or for a PR comment |
| `workspace check` | Whether every package declares what it imports |

## Next steps

- Copy a workflow from [`examples/github-actions`](../examples/github-actions)
  into your own repository.
- [impact-and-workspace.md](./impact-and-workspace.md) covers what static
  analysis cannot see. Read it before you rely on either command in CI.
- [cli-reference.md](./cli-reference.md) lists every command and flag, and
  [api.md](./api.md) documents every JSON output.
