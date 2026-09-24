# PR commands

variant's `pr` subcommands classify what a pull request actually changes at the TypeScript AST level, and render the result for a human or for CI.

![Running `variant pr check --base main`: price.ts is breaking, slug.ts is non-impacting, verdict build required](./assets/pr-check.gif)

## Commands

### `pr check`

Classifies every changed `.ts` / `.tsx` file by comparing its exported symbols before and after:

```bash
variant pr check
variant pr check --base origin/main
```

Output:

```
Base ref: main
Changed .ts files: 4

File classifications:
  non-impacting  src/utils/format.ts
  internal       src/hooks/useCart.ts  (~2 changed)
  breaking       src/api/checkout.ts   (-1 removed, ~1 changed)

Verdict: build required
```

**Classifications:**

| Label | Meaning |
|-------|---------|
| `non-impacting` | Nothing but comments or whitespace changed |
| `internal` | Code changed, but no exported signature did: implementation only |
| `breaking` | An exported signature changed, or an export was added or removed |

The parenthesis counts exported symbols added (`+`), removed (`-`) and changed (`~`).

**Verdicts:**

| Verdict | Triggered when |
|---------|---------------|
| `safe to skip build` | All files are `non-impacting` |
| `build recommended` | At least one file is `internal` |
| `build required` | At least one file is `breaking` |

### `pr report`

Renders the `pr check` verdict as a report artifact:

```bash
# JSON to stdout
variant pr report

# Markdown suitable for a GitHub comment
variant pr report --markdown

# Write to a file
variant pr report --markdown --output pr-report.md
```

JSON output shape:

```json
{
  "generatedAt": "2026-06-08T12:00:00.000Z",
  "check": {
    "baseRef": "main",
    "tsFilesChanged": 4,
    "files": [...],
    "verdict": "build-required"
  }
}
```

Every field, and the exact markdown layout, is in the [API reference](./api.md#pr-report).

## GitHub Actions integration

[`examples/github-actions/pr-report.yml`](../examples/github-actions/pr-report.yml) is a complete workflow: it runs `pr report --markdown` on every pull request and keeps one sticky comment up to date, using the default `GITHUB_TOKEN`. The step that matters:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0

- env:
    BASE_REF: origin/${{ github.base_ref }}
  run: npx --yes @blzsky/variant pr report --base "$BASE_REF" --markdown --output pr-report.md
```

Both details are load-bearing. `pr check` and `pr report` diff from the merge base with `--base`, so they need history: a shallow clone has none. And `actions/checkout` creates no local branch for the target, so `--base main` names nothing, while `--base origin/main` resolves.

## Options

Both `pr` commands accept:

| Flag | Default | Description |
|------|---------|-------------|
| `--base <ref>` | `main` | Git ref to diff against |

Both diff `<ref>...HEAD`: the committed changes since the branch left `<ref>`. Uncommitted changes are not included.

> **A ref that does not resolve is not an error.** `pr check` then reports zero changed files and `safe to skip build`. Check the ref with `git rev-parse --verify <ref>` before trusting a verdict in a new setup.

`pr report` also accepts:

| Flag | Default | Description |
|------|---------|-------------|
| `--markdown` | false | Output GitHub-comment-ready Markdown instead of JSON |
| `--output <file>` | stdout | Write output to a file |
