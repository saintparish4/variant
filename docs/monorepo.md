# Monorepo setup

variant has first-class support for pnpm workspaces, npm workspaces, and Yarn workspaces. This guide walks through a pnpm workspace setup.

## Workspace discovery

variant discovers packages from the first of these it finds:

1. `pnpm-workspace.yaml` (its `packages:` list)
2. the `package.json` `workspaces` field (npm / Yarn)
3. the directories `packages/*`, `apps/*` and `services/*`

A directory counts as a package only if its `package.json` has a `name`. The change-intelligence commands (`impact`, `workspace check`) use this discovery with no config at all. The task runner needs workspace mode enabled in your config:

```typescript
// variant.config.ts
import { defineConfig } from "@blzsky/variant";

export default defineConfig({
  strategy: "adaptive",
  workspace: {
    enabled: true,
    scripts: ["build", "test", "lint"],
  },
  tasks: {
    build: {
      command: "pnpm run build",
      inputs: ["src/**/*", "package.json"],
    },
    test: {
      command: "pnpm test",
      inputs: ["src/**/*", "tests/**/*"],
      dependsOn: ["build"],
    },
    lint: {
      command: "pnpm run lint",
      inputs: ["src/**/*", "*.config.*"],
    },
  },
});
```

`workspace.scripts` is the list of scripts that variant auto-generates cross-package tasks for. When `build` is in that list, variant creates a `<package-name>:build` task for every discovered workspace package (where `<package-name>` is the `name` field in the package's `package.json`).

## Git-diff scoping

By default, `git.enabled: true` runs a `git diff HEAD~1` before hashing. Only changed packages are hashed; untouched packages always cache-hit regardless of their inputs.

Customize the base ref:

```typescript
git: {
  baseRef: "origin/main",  // compare against main instead of parent commit
}
```

## `--affected`: run only what changed

```bash
variant build --affected
```

`--affected` computes the set of packages whose files changed on the current branch, then **cascades** to include any package that depends on a changed package (transitively). Tasks for packages outside the affected set are recorded as `SKIP`.

### Example

Suppose your workspace has:

```
packages/
  utils/      (shared utilities)
  web/        (depends on utils)
  api/        (depends on utils)
  docs/       (standalone, no utils dependency)
```

If you change a file in `packages/utils`, `--affected` will include `utils`, `web`, and `api` (because they depend on `utils`), but skip `docs`.

```
variant build --affected

TASK               DURATION   STATUS
--------------------------------------
utils:build        2100ms     MISS
web:build          5400ms     MISS
api:build          3200ms     MISS
docs:build         -          SKIP
```

## pnpm workspace example layout

```
my-monorepo/
  variant.config.ts
  pnpm-workspace.yaml
  package.json
  packages/
    ui/
      package.json
      src/
    web/
      package.json
      src/
    api/
      package.json
      src/
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

`variant.config.ts` at the workspace root:

```typescript
import { defineConfig } from "@blzsky/variant";

export default defineConfig({
  strategy: "adaptive",
  workspace: {
    enabled: true,
    scripts: ["build", "test", "lint"],
  },
  git: {
    baseRef: "origin/main",
  },
  tasks: {
    build: {
      command: "pnpm run build",
      inputs: ["src/**/*", "package.json"],
    },
    test: {
      command: "pnpm test",
      inputs: ["src/**/*"],
      dependsOn: ["build"],
    },
    lint: {
      command: "pnpm run lint",
      inputs: ["src/**/*"],
    },
  },
});
```

Run from the workspace root:

```bash
# Build only what changed on this branch
variant build --affected

# Run everything (full build with caching)
variant build
```

## Troubleshooting

See [troubleshooting.md](./troubleshooting.md) — workspace-specific issues are covered in items 4–6.
