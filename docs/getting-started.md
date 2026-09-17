# Getting started

variant reads a TypeScript diff at the AST level and tells you which tests that
change actually needs. This guide runs it against your own repository — no
config file, no setup — and then covers the task runner underneath it.

## Prerequisites

- Node.js ≥ 20
- A git repository with at least one prior commit
- TypeScript sources (`.ts`/`.tsx`)

## 1. Run it

`impact` needs no config file. Point it at a commit range:

```bash
npx vrnt impact --base HEAD~1
```

The package is `vrnt`; the command it installs is `variant`. `npx vrnt` runs it
without installing. (`npx variant` would fetch an unrelated package of that
name, so never write that.) To install it:

```bash
npm install -D vrnt
```

After which the command is `variant`:

```bash
variant impact --base origin/main
```

## 2. Read the output

For a change that only touched the body of one exported function:

```
Base ref: HEAD~1

You changed 1 file.
  internal       src/math.ts

Impact: 1 file

Run:   1 test file
Skip:  1 test file (of 2 total)

Verdict:    build recommended
Confidence: 100%  (report-only — run the full suite; skipping unlocks after shadow-mode validation)
```

Reading it:

- **`internal`** — the exported signature did not change, only the body. A
  dependent that calls `add` still compiles; one that only imports `mul` is
  untouched. The three classifications are `non-impacting`, `internal` and
  `breaking`; anything that is not TypeScript is `unanalyzed`.
- **Run / Skip** — the tests whose static import closure reaches a changed
  file, and the rest.
- **Confidence** — how much of the import graph resolved, *not* a safety
  number. Unresolved specifiers and dynamic `import()` lower it and add a note.
- **Report-only.** variant never skips anything for you. Every prediction is
  appended to `.variant/history/impact.jsonl` so the false-skip rate can be
  measured before skipping is ever offered.

Add `--json` for the machine-readable form, which includes the full blast
radius and every note.

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
for a sticky PR comment — see [pr-commands.md](./pr-commands.md).

In a monorepo, `variant workspace check` is a CI gate for undeclared
dependencies and cross-package relative imports. Both commands are covered in
[impact-and-workspace.md](./impact-and-workspace.md), including the cases where
static analysis cannot see an edge.

## 4. Optional: the task runner

variant also runs your tasks as a cached DAG. This part needs a config file.

```bash
variant init
```

`init` detects your package manager, framework, and existing `package.json`
scripts, then writes `variant.config.ts`:

```typescript
// variant.config.ts
import { defineConfig } from "vrnt";

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

- **[impact-and-workspace.md](./impact-and-workspace.md)** — what `impact` can
  and cannot see, and how `workspace check` is configured.
- **[pr-commands.md](./pr-commands.md)** — `pr check` and `pr report` in CI.
- **[monorepo.md](./monorepo.md)** — workspace task generation and `--affected`.
- **[config-reference.md](./config-reference.md)** — every config key.
- **Tune `inputs`** to be as narrow as possible: the narrower the glob, the
  fewer cache invalidations.
