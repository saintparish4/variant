# Config reference

All configuration lives in `variant.config.ts` (or `.js` / `.mjs` / `.json`) at your project root. The config is loaded via [jiti](https://github.com/unjs/jiti), so TypeScript is supported without a build step. The JSON format (`variant.config.json`) is also accepted for environments where TypeScript is unavailable.

```typescript
import { defineConfig } from "variantjs";

export default defineConfig({ ... });
```

---

## Top-level keys

### `strategy`

| | |
|-|-|
| Type | `"adaptive" \| "strict"` |
| Default | `"adaptive"` |

- `"adaptive"` — cache-aware; tasks whose inputs haven't changed are skipped.
- `"strict"` — always runs every task regardless of cache state.

```typescript
strategy: "adaptive",
```

---

## `cache`

### `cache.mode`

| | |
|-|-|
| Type | `"content"` |
| Default | `"content"` |

Only content-based hashing is supported. This field exists for forward compatibility.

### `cache.directory`

| | |
|-|-|
| Type | `string` |
| Default | `".variant/cache"` |

Directory where local cache entries are stored. Relative to the project root.

```typescript
cache: {
  directory: ".variant/cache",
},
```

### `cache.ttlDays`

| | |
|-|-|
| Type | `number` |
| Default | `undefined` (no eviction) |

Evict local cache entries older than this many days at the start of every run.

```typescript
cache: {
  ttlDays: 30,
},
```

---

## `tasks`

A map of named tasks.

```typescript
tasks: {
  build: {
    command: "npm run build",
    inputs: ["src/**/*", "package.json"],
    dependsOn: ["typecheck"],
  },
},
```

### `tasks.<name>.command`

| | |
|-|-|
| Type | `string` |
| Default | `<pm> run <taskName>` |

The shell command to run for this task. If omitted, defaults to `npm run <name>`, `pnpm run <name>`, or `yarn <name>` based on detected package manager.

### `tasks.<name>.inputs`

| | |
|-|-|
| Type | `string[]` |
| Default | `[]` |

Glob patterns relative to the project root. The SHA-256 hash of all matched file contents determines whether the task is a cache hit. An empty `inputs` array means the task is always a cache miss.

### `tasks.<name>.dependsOn`

| | |
|-|-|
| Type | `string[]` |
| Default | `[]` |

Tasks that must complete before this task starts. All referenced task names must exist in `tasks`. The DAG validator will report an error otherwise.

### `tasks.<name>.cpuHeavy`

| | |
|-|-|
| Type | `boolean` |
| Default | `undefined` |

Hint to the `pack-heavy` scheduler policy that this task should be scheduled before lighter tasks to minimize total wall-clock time.

---

## `workspace`

### `workspace.enabled`

| | |
|-|-|
| Type | `boolean` |
| Default | `false` |

Enable workspace / PackageGraph discovery. When `true`, variant discovers all workspace packages and auto-generates `<package-name>:<script>` tasks for each script in `workspace.scripts`.

### `workspace.scripts`

| | |
|-|-|
| Type | `string[]` |
| Default | `["build", "test", "lint"]` |

Scripts to auto-generate cross-package tasks for.

---

## `git`

### `git.enabled`

| | |
|-|-|
| Type | `boolean` |
| Default | `true` |

Enable the git-diff pre-filter. When enabled, only packages with changed files (since `git.baseRef`) are included in the hash scope. Unchanged packages cache-hit without being hashed.

### `git.baseRef`

| | |
|-|-|
| Type | `string` |
| Default | `"HEAD~1"` |

The git ref used for the diff. Common values:

- `"HEAD~1"` — compare against the previous commit
- `"origin/main"` — compare against the main branch

---

## `semanticDiff`

### `semanticDiff.enabled`

| | |
|-|-|
| Type | `boolean` |
| Default | `false` |

Enable AST-based semantic diff hooks (experimental). When enabled, the classifier runs on changed TypeScript files and may influence task filtering.

---

## `scheduler`

### `scheduler.policy`

| | |
|-|-|
| Type | `"auto" \| "light-first" \| "pack-heavy" \| "critical-path"` |
| Default | `"auto"` |

Controls how the event-driven scheduler orders task execution within a DAG level.

| Value | Behavior |
|-------|---------|
| `"auto"` | Starts tasks as soon as their dependencies finish; no ordering preference |
| `"light-first"` | Schedules tasks without the `cpuHeavy` hint before tasks with it |
| `"pack-heavy"` | Schedules `cpuHeavy` tasks first to minimize wall-clock time |
| `"critical-path"` | Reserved; currently treated as `"auto"` (full implementation planned) |

---

## Full example

```typescript
import { defineConfig } from "variantjs";

export default defineConfig({
  strategy: "adaptive",

  cache: {
    directory: ".variant/cache",
    ttlDays: 14,
  },

  tasks: {
    typecheck: {
      command: "tsc --noEmit",
      inputs: ["src/**/*", "tsconfig.json"],
    },
    build: {
      command: "next build",
      inputs: ["src/**/*", "app/**/*", "package.json"],
      dependsOn: ["typecheck"],
    },
    lint: {
      command: "next lint",
      inputs: ["src/**/*", "app/**/*"],
    },
    test: {
      command: "vitest run",
      inputs: ["src/**/*"],
      dependsOn: ["build"],
    },
  },

  workspace: {
    enabled: true,
    scripts: ["build", "lint", "test"],
  },

  git: {
    baseRef: "origin/main",
    enabled: true,
  },

  scheduler: {
    policy: "auto",
  },
});
```
