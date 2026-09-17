# PR commands

variant's `pr` subcommands help you understand what a pull request actually changes — both at the TypeScript AST level and in terms of which routes and packages your running app loads.

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

### `pr replay`

Loads the last recorded trace session and intersects the list of changed files with the modules recorded during that session:

```bash
variant pr replay
variant pr replay --base origin/main --session <sessionId>
```

Output:

```
Base ref:        main
Trace session:   abc123
Framework:       next
Changed files:   6
Touched modules: 2

Touched routes:
  /checkout  (44 modules)
  /cart      (31 modules)

Touched packages:
  @myapp/ui
  @myapp/checkout
```

This tells you which user-facing routes are affected by the PR — useful for deciding what to manually test.

### `pr report`

Runs both `pr check` and `pr replay` and produces a combined report:

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
  },
  "replay": {
    "baseRef": "main",
    "sessionId": "abc123",
    "framework": "next",
    "changedFiles": [...],
    "touchedModules": [...],
    "touchedRoutes": [...],
    "touchedPackages": [...]
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

All three `pr` commands accept:

| Flag | Default | Description |
|------|---------|-------------|
| `--base <ref>` | `main` | Git ref to diff against |

`pr replay` and `pr report` also accept:

| Flag | Default | Description |
|------|---------|-------------|
| `--session <id>` | last recorded | Trace session to use for replay |

`pr report` also accepts:

| Flag | Default | Description |
|------|---------|-------------|
| `--markdown` | false | Output GitHub-comment-ready Markdown instead of JSON |
| `--output <file>` | stdout | Write output to a file |
