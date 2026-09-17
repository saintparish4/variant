# PR commands

variant's `pr` subcommands classify what a pull request actually changes at the TypeScript AST level, and render the result for a human or for CI.

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
| `non-impacting` | No exported symbols changed (comments, whitespace, private code) |
| `internal` | Exported symbols changed in a backwards-compatible way |
| `breaking` | Exported symbols removed or their signatures changed |

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

## GitHub Actions integration

There is no ready-made workflow to install yet. `pr report --markdown` writes a file that any commenting action can post, so the integration is a few lines in your own workflow:

```yaml
- run: npx vrnt pr report --base ${{ github.base_ref }} --markdown --output pr-report.md
```

Feed `pr-report.md` to `actions/github-script` (or `peter-evans/create-or-update-comment`) with a fixed marker line such as `## Variant PR Report` so each run updates the same sticky comment instead of adding a new one. The default `GITHUB_TOKEN` is enough — no extra secrets.

## Options

Both `pr` commands accept:

| Flag | Default | Description |
|------|---------|-------------|
| `--base <ref>` | `main` | Git ref to diff against |

`pr report` also accepts:

| Flag | Default | Description |
|------|---------|-------------|
| `--markdown` | false | Output GitHub-comment-ready Markdown instead of JSON |
| `--output <file>` | stdout | Write output to a file |
