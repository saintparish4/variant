# Remote cache

A remote cache lets multiple machines (CI runners, developer laptops) share cache hits. When any machine builds a task and the hash matches a stored entry, the task is skipped — even if it has never run on that machine before.

## How it works

After every task run:

1. variant checks the remote cache for the task's input hash.
2. On a **remote hit**, the task is skipped and marked `REMOTE HIT` in the insight table.
3. On a miss, the task runs and the result hash is written to both the local and remote cache.

## Backends

### HTTP backend

Works with any server that handles `GET`, `PUT`, and `HEAD` requests at `{baseUrl}/{hash}`. Compatible with S3 presigned URLs, Cloudflare R2, GCS signed URLs, or a simple Express server.

```typescript
// variant.config.ts
import { defineConfig } from "vrnt";

export default defineConfig({
  cache: {
    remote: {
      type: "http",
      url: "https://cache.example.com",
      headers: {
        // Read the token from the environment — never hard-code it. See the
        // security note below.
        Authorization: `Bearer ${process.env.VARIANT_CACHE_TOKEN ?? ""}`,
      },
      timeout: 15000,
    },
  },
  tasks: { ... },
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | — | Base URL; each hash appended as `{url}/{hash}` |
| `headers` | `Record<string, string>` | `{}` | Request headers sent with every request |
| `timeout` | `number` (ms) | `10000` | Per-request timeout |
| `maxResponseBytes` | `number` | `1048576` (1 MiB) | Caps the GET response body; oversized responses are rejected |

> **Security: never commit secrets to `variant.config.ts`.** The config file
> is checked into source control, so any `Authorization` token, API key, or
> password written there will leak. Read credentials from environment variables
> instead (as shown above) and inject them via your CI secret store or a local
> `.env` that is git-ignored. The same applies to the S3 backend, which by
> design has no `credentials` field and relies on the AWS credential chain.

### S3 backend

Uses `@aws-sdk/client-s3` (lazy-imported on first use — install it separately):

```bash
npm install @aws-sdk/client-s3
```

```typescript
cache: {
  remote: {
    type: "s3",
    bucket: "my-variant-cache",
    region: "us-east-1",
    prefix: "variant/",  // optional key prefix
  },
},
```

For R2, MinIO, or localstack, add `endpoint`:

```typescript
cache: {
  remote: {
    type: "s3",
    bucket: "my-cache",
    region: "auto",
    endpoint: "https://account.r2.cloudflarestorage.com",
  },
},
```

Credentials are resolved via the standard AWS credential chain (environment variables, `~/.aws/credentials`, instance profile). Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in your environment — there is no `credentials` field in `variant.config.ts`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bucket` | `string` | — | S3 bucket name |
| `region` | `string` | — | AWS region |
| `prefix` | `string` | `"variant/"` | Key prefix for all objects |
| `endpoint` | `string` | — | Custom endpoint for R2/MinIO/localstack |

## TTL eviction

Automatically evict local cache entries older than N days:

```typescript
cache: {
  ttlDays: 30,
},
```

Eviction runs at the start of every variant run. Entries older than `ttlDays` are deleted before hashing begins.

## Cost modeling

Annotate the expected cost of a cache miss so the insight summary can report accurate time-saved estimates:

```typescript
cache: {
  costPerMissMs: 45000,  // expected build time when there's a miss
},
```

The `variant insight` footer shows:

```
Remote cache hits: 3  Estimated time saved: 135000ms
```

## CI example (GitHub Actions with S3)

```yaml
- name: Run build
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.CACHE_AWS_KEY }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.CACHE_AWS_SECRET }}
  run: npx vrnt build
```

`variant.config.ts`:

```typescript
cache: {
  remote: {
    type: "s3",
    bucket: "my-ci-cache",
    region: "us-east-1",
  },
  ttlDays: 14,
  costPerMissMs: 60000,
},
```

## Checking remote hit stats

```bash
variant insight
```

The STATUS column shows `HIT` for both local and remote hits. Remote hits are counted separately in the footer line printed below the table.
