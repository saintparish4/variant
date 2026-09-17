# Troubleshooting

## 1. Every task is always a cache miss

**Cause:** The `inputs` array for a task is empty or the glob doesn't match any files.

**Fix:** Verify the globs match your source files. variant uses `fast-glob` internally and ignores `node_modules/`, `.git/`, and `.variant/`. Use `find` to approximate the same check:

```bash
# macOS / Linux
find src -type f

# The exact pattern variant uses (excludes node_modules, .git, .variant):
find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./.variant -prune -o -name '*.ts' -print
```

Then check your config:

```typescript
tasks: {
  build: {
    inputs: ["src/**/*", "package.json"],  // must match at least one file
  },
},
```

An empty `inputs: []` means the task never hashes — it will always be a cache miss.

---

## 2. `variant: command not found`

**Cause:** The binary isn't on PATH. variant is installed as a local dev dependency.

**Fix:** Use `npx` or add a script to `package.json`:

```bash
variant build
```

Or add to `package.json`:

```json
{
  "scripts": {
    "build:cached": "variant build"
  }
}
```

---

## 3. Config file not found

**Cause:** variant looks for `variant.config.ts`, `variant.config.js`, or `variant.config.mjs` in the current working directory.

**Fix:** Create the config with `variant init`, or check you're running from the project root.

Note: the config filename is `variant.config.ts` (no `r` at the end), while the package name and CLI are `variant`.

---

## 4. Workspace packages not discovered

**Cause:** `workspace.enabled` is not set to `true`, or the workspace manifest isn't in the expected location.

**Fix:** Enable workspace mode and verify your workspace manifest:

```typescript
workspace: {
  enabled: true,
}
```

variant looks for:
- `pnpm-workspace.yaml` (pnpm)
- `package.json` `workspaces` field (npm / Yarn)
- `tsconfig.json` project references

Run `variant env` to see what was detected.

---

## 5. `--affected` runs all packages instead of just changed ones

**Cause:** Git is disabled, the base ref doesn't point to the expected commit, or `.git` isn't accessible from the working directory.

**Fix:** Check git config:

```typescript
git: {
  enabled: true,
  baseRef: "origin/main",  // adjust to match your branching strategy
},
```

Run `git diff --name-only origin/main` manually to verify the diff is what you expect — this is the exact command variant runs internally with that `baseRef`.

---

## 6. Workspace package not included in `--affected` cascade

**Cause:** The package's `package.json` doesn't declare the changed package as a dependency, so the cascade doesn't reach it.

**Fix:** Ensure the dependent package lists the changed package in `dependencies` or `devDependencies` in its own `package.json`. variant's cascade walks workspace dependency edges, not just `dependsOn` in the task graph.

---

## 7. `variant doctor` reports a validation error

**Cause:** The config failed Zod validation, usually due to an unknown task referenced in `dependsOn` or a typo in a field name.

**Fix:** The error message includes the exact path. Example:

```
[✗] Config validation failed
      → tasks.test.dependsOn: references unknown task "builds" — add it to config.tasks or remove the reference
```

Check that every task name in `dependsOn` matches a key in `tasks`.

---

## 8. A failure prints "ran because:" — what is it telling me?

When a task fails, variant adds a short block explaining why that task was selected to run:

```
[TASK_EXECUTION_ERROR] Task "web:build" failed with exit code 1
  ran because: packages/api/src/db.ts changed
  also affected: web:test, web:typecheck
  Hint: Check the output above, fix the failing command in task "web:build", then re-run.
```

**`ran because:`** is one of three answers:

| Line | Meaning |
|------|---------|
| `<files> changed` | The current diff touched these files, which put the task in scope. |
| `cache miss — inputs hash <a>, cached <b>` | The task's inputs hashed differently than the cached run. |
| `cache miss — nothing cached for this task yet` | A first run, not an invalidation — there was nothing to compare against. |
| `this task is never cached, so it runs every time` | The task has no `inputs`, or `strategy: "strict"` opts it out of caching. See issue 1 above. |

**`also affected:`** lists the other tasks this run invalidated. It appears only when there are any.

**This does not explain why the task failed.** It answers "why did this run at all", which is a different question. A task can be selected because `db.ts` changed and then fail for a reason with nothing to do with `db.ts` — treat the file list as a place to start looking, not a cause. The failing command's own output, above the block, is the actual evidence.

The block appears on stderr, only on failure, and only for errors belonging to a task — config and usage errors have no task to explain. Colors follow the same rules as the rest of the CLI (`NO_COLOR`, `--no-color`, `FORCE_COLOR`); when styling is off the same text still prints.

---

## Still stuck?

Run `variant doctor` — it checks the most common issues automatically. If the problem persists, open an issue at [github.com/saintparish4/variant](https://github.com/saintparish4/variant/issues) with the output of:

```bash
variant doctor
variant env
```
