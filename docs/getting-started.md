# Getting started

variant reads a TypeScript diff at the AST level and tells you which tests that
change actually needs. This guide runs it against your own repository — no
config file, no setup — and then covers the task runner underneath it.

Prefer a guided run on a sample project first? The
[tutorial](./tutorial.md) walks through every command on a three-package
monorepo.

## Prerequisites

- Node.js ≥ 20
- A git repository with at least one prior commit
- TypeScript sources (`.ts`/`.tsx`)

## 1. Run it

`impact` needs no config file. Point it at a commit range:

```bash
npx @blzsky/variant impact --base HEAD~1
```

The package is `@blzsky/variant`; the command it installs is `variant`. `npx @blzsky/variant` runs it
without installing. (`npx variant` would fetch an unrelated package of that
name, so never write that.) To install it:

```bash
npm install -D @blzsky/variant
```

After which the command is `variant`:

```bash
variant impact --base origin/main
```

## 2. Read the output

For a change that only touched the body of one exported function:

```
Base ref: HEAD~1
Workspace: no workspace packages found

You changed 1 file.
  internal       src/math.ts

Impact: 1 file

Run:   1 test file
Skip:  1 test file (of 2 total)

Verdict:    build recommended
Confidence: high (100%)  (report-only — run the full suite; skipping unlocks after shadow-mode validation)
```

Reading it:

- **`internal`** — the exported signature did not change, only the body.
  Dependents still compile, so the change does not spread through the blast
  radius (`Impact`). Every test that imports `math.ts`, directly or through
  other files, is still selected: a new implementation can change what a test
  observes. The three classifications are `non-impacting`, `internal` and
  `breaking`; anything that is not TypeScript is `unanalyzed`.
- **Run / Skip** — the tests whose static import closure reaches an affected
  file, and the rest. Here the skipped test never imports `math.ts`.
- **Confidence** — how much of the import graph resolved, *not* a safety
  number. Unresolved specifiers and dynamic `import()` lower it and add a note.
- **Report-only.** variant never skips anything for you. Every prediction is
  appended to `.variant/history/impact.jsonl` so the false-skip rate can be
  measured before skipping is ever offered.

Add `--json` for the machine-readable form, which includes the full blast
radius and every note; its shape is in the [API reference](./api.md#impact---json).

`--base` compares the ref's commit with your working tree, so on a branch that
has fallen behind `main`, `--base main` also reports what landed on `main`
since. Pass `--base "$(git merge-base main HEAD)"` to see only your branch; the
[CLI reference](./cli-reference.md#refs-and-diffs) has the details.

To check a prediction against reality, keep the test runner's JSON report and
reconcile it:

```bash
npx vitest run --reporter=json --outputFile=report.json
variant impact verify report.json
```

That reports **false skips** — tests that failed and that the prediction did not
select. See [impact-and-workspace.md](./impact-and-workspace.md).

## 3. Use it on a PR

```bash
variant pr check --base origin/main
variant pr report --base origin/main --markdown --output pr-report.md
```

`pr check` classifies every changed TypeScript file and rolls the result into
one verdict. `pr report` renders the same thing as JSON or as markdown suitable
for a sticky PR comment — see [pr-commands.md](./pr-commands.md), and
[`examples/github-actions`](../examples/github-actions) for workflows to copy.

In a monorepo, `variant workspace check` is a CI gate for undeclared
dependencies and cross-package relative imports. Both commands are covered in
[impact-and-workspace.md](./impact-and-workspace.md), including the cases where
static analysis cannot see an edge.

## 4. Optional: the task runner

variant also runs your tasks as a cached DAG. This part needs a config file.

```bash
variant init --tasks
```

`init --tasks` detects your package manager, framework, and existing `package.json`
scripts, then writes `variant.config.ts`:

```typescript
// variant.config.ts
import { defineConfig } from "@blzsky/variant";

export default defineConfig({
  strategy: "adaptive",
  tasks: {
    build: {
      command: "npm run build",
      inputs: ["src/**/*", "package.json"],
    },
    test: {
      command: "npm test",
      inputs: ["src/**/*", "tests/**/*"],
      dependsOn: ["build"],
    },
  },
});
```

Check it:

```bash
variant doctor
```

```
[✓] Node v22.4.0 meets requirement ≥20
[✓] Config found: variant.config.ts
[✓] Config is valid
[✓] Cache directory is 0 MB
```

First run — every input hashes to a miss, so both tasks execute in dependency
order:

```bash
variant build
```

```
TASK    DURATION   STATUS
-------------------------------
build   4200ms     MISS
test    12100ms    MISS
```

Run it again without touching a source file and both are served from the cache:

```
TASK    DURATION   STATUS
-------------------------------
build   -          HIT
test    -          HIT
```

`variant insight` shows each task's last run timestamp and duration from the
local cache history.

## Next steps

- **[tutorial.md](./tutorial.md)** — every change-intelligence command on a
  sample monorepo, including reconciling a prediction with a real test run.
- **[impact-and-workspace.md](./impact-and-workspace.md)** — what `impact` can
  and cannot see, and how `workspace check` is configured.
- **[cli-reference.md](./cli-reference.md)** and **[api.md](./api.md)** —
  every command, flag and JSON output.
- **[pr-commands.md](./pr-commands.md)** — `pr check` and `pr report` in CI.
- **[monorepo.md](./monorepo.md)** — workspace task generation and `--affected`.
- **[config-reference.md](./config-reference.md)** — every config key.
- **Tune `inputs`** to be as narrow as possible: the narrower the glob, the
  fewer cache invalidations.
