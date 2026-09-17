# Benchmarks

Reproducible benchmark harness for the performance claims in the main README. Every number variant advertises should be regenerable with one command — a number without a script attached is marketing, not a measurement.

## Run it

```bash
pnpm build        # the harness measures dist/cli.js, so build first
pnpm bench        # full run (~2–5 min)
pnpm bench:quick  # sanity pass — fewer runs, no 10,000-file tier
```

Only Node is required. If [hyperfine](https://github.com/sharkdp/hyperfine) is on your PATH it is used as the timing tool (recommended — `apt install hyperfine`, `brew install hyperfine`, or `winget install hyperfine`); otherwise a built-in timer applies the same warmup/run protocol.

Results are written to `benchmarks/results/latest.md` (paste-ready markdown table) and `benchmarks/results/latest.json` (raw data including per-run times). Both are gitignored — CI artifacts and the README are the published copies.

## What it measures and why

| Scenario | Claim it proves |
|----------|-----------------|
| CLI startup — `variant --help` | The lazy-import design keeps the binary interactive; enforced < 200 ms in CI |
| Baseline — raw `node --version` | The command the fixture task wraps, measured alone so overhead can be isolated |
| Warm run — cache hit at 100 / 1,000 / 10,000 files | Full wall time of a skipped build (process start + config load + hashing + one `cache.json` read); the build command is never spawned, and cost scales with file count, not build complexity |
| Cold run — no cache, 1,000 files | End-to-end orchestration when every task must execute |
| Orchestration overhead (derived) | Cold run minus baseline = what variant itself costs on top of your build tool |

Fixtures are generated deterministically (seeded LCG) into a temp directory, so the same tier produces byte-identical projects on every machine, and nothing inside this repository is touched or timed. The fixture task command is `node --version` — deliberately near-zero — so cold-run time is dominated by variant's own work rather than a build tool's.

Warm-run caches are primed with two untimed runs before measurement. The cold scenario deletes `.variant/` before every timed run (excluded from timing). The reported statistic is the **median**; mean ± σ, min, and the full run distribution are in `latest.json`.

## CI

[`.github/workflows/benchmark.yml`](../.github/workflows/benchmark.yml) runs the full harness on `ubuntu-latest` for every push to `master` (and on demand via workflow dispatch). It publishes the table to the job summary, uploads `results/` as an artifact, and **fails the job if CLI startup median exceeds 200 ms** — the README's startup claim is a regression gate, not a promise.

## Caveats

- Benchmark on an idle machine; a busy laptop inflates variance far more than it shifts medians.
- Under WSL2, this repo lives on `/mnt/c`, where Windows-filesystem I/O badly distorts the file-heavy scenarios. Run the harness natively (PowerShell on Windows) or treat the CI numbers as canonical.
- Numbers from different machines belong in different tables — never mix them in one report. The environment line printed under the table exists so this is checkable.

## Other files

- `Audit-Checklist.txt` — recorded output from a manual audit pass.
