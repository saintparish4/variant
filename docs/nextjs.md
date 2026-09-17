# Next.js setup

variant provides a webpack plugin for Next.js that records which modules and routes are loaded during builds and dev runs. This data powers two features:

- **`variant trace analyze`** — inspect which files and routes a trace session loaded
- **Lint-only fast path** — skip builds entirely when a PR touches no critical route

## 1. Install the tracer plugin

```bash
npm install -D vrnt
```

## 2. Add the webpack plugin

```javascript
// next.config.js (or next.config.mjs)
import { variantNextPlugin } from "vrnt/tracer";

export default {
  webpack(config, { isServer }) {
    if (!isServer) {
      config.plugins.push(variantNextPlugin());
    }
    return config;
  },
};
```

The plugin writes trace sessions to `.variant/traces/<sessionId>.json` during every build or `next dev` run.

## 3. Record a trace session

```bash
variant trace
```

This starts `next dev` (or your configured dev command) with tracing active. Browse your app or hit any routes you consider critical. Stop the server with Ctrl-C.

```bash
# Inspect the most recent session
variant trace analyze

# Inspect a specific session
variant trace analyze <sessionId>
```

`trace analyze` prints:

```
Trace session : abc123
Framework     : next
Started       : 6/8/2026, 12:00:00 PM
Duration      : 4320ms
Modules       : 142
Routes        : 8

Routes:
  /                (18 modules)
  /dashboard       (31 modules)
  /checkout        (44 modules)
  /login           (22 modules)

Packages touched (3):
  @myapp/ui                        48 modules
  @myapp/checkout                  44 modules
  @myapp/shared                    21 modules
```

## 4. Enable the lint-only fast path

When `lintOnlyForNonCritical` is on, variant checks whether any changed file intersects the modules recorded for your declared critical routes. If no critical route is touched, variant restricts the run to lint tasks only and skips all builds.

```typescript
// variant.config.ts
import { defineConfig } from "vrnt";

export default defineConfig({
  tasks: {
    build: {
      command: "next build",
      inputs: ["src/**/*", "app/**/*", "pages/**/*", "package.json"],
    },
    lint: {
      command: "next lint",
      inputs: ["src/**/*", "app/**/*", "pages/**/*"],
    },
  },
  performance: {
    lintOnlyForNonCritical: true,
    criticalPaths: ["/checkout", "/login", "/api/payment"],
  },
});
```

When a PR only touches, say, the `/about` page (stderr notice + table):

```
[variant] No critical-path changes detected — running lint tasks only

TASK    DURATION   STATUS
---------------------------
lint    8200ms     MISS
build   -          SKIP
```

When a PR touches `/checkout`, all tasks run normally:

```
TASK    DURATION   STATUS
---------------------------
build   42300ms    MISS
lint    8200ms     MISS
```

## 5. Prioritize traced packages in a build

`--scope` switches to the event-driven scheduler and gives traced packages the highest priority, so they are scheduled before any non-traced packages. All packages still run; the flag controls order, not which tasks execute.

```bash
variant build --scope <sessionId>

# Shorthand for the most recent session
variant build --trace last
```

## Config reference

See [config-reference.md](./config-reference.md) for all `performance.*` keys.
