# CSS performance harness

Dependency-free tooling to measure the performance of a Community Solid Server build:
throughput, latency percentiles, file-system operations (total, per request, per second,
per call site, per path pattern), CPU time, RSS, and cold-boot cost.

It was built to produce the A/B numbers for the performance PR series and is meant to be
run against **two checkouts** (baseline and candidate) so results are always comparative.

## Contents

| File | Purpose |
| --- | --- |
| `fs-count.js` | Preload (`node --require`) that counts every `fs`/`fs.promises` call in the server process |
| `runner.js` | Boots a server with the preload and drives the scenario suite against it |
| `loadgen.js` | Minimal `fetch`-based load generator (used by the runner, also standalone) |
| `bench-setup.js` | Creates an account, pod, client credentials and public benchmark containers |
| `report.js` | Renders one or more result files as a markdown comparison table |

## Quick start

```bash
# In two builds of the server (e.g. main and your branch):
node scripts/perf/runner.js --serverDir ../css-baseline --label baseline --out baseline.json
node scripts/perf/runner.js --serverDir ../css-candidate --label candidate --out candidate.json

# Markdown A/B report (first file is the baseline for the % deltas):
node scripts/perf/report.js baseline.json candidate.json
```

The `--serverDir` must be a **built** checkout (`bin/server.js` and `node_modules` present);
`jose` is resolved from that checkout to sign the DPoP tokens used during setup.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--serverDir` | (required) | Path to the built CSS checkout to benchmark |
| `--config` | `config/file.json` | Server configuration to boot |
| `--port` | `3460` | Port to bind |
| `--label` | `run` | Label used in the output and the console log |
| `--out` | `<label>.json` | Result file |
| `--seconds` | `10` | Duration of each load scenario |
| `--conc` | `20` | Concurrent workers per load scenario |
| `--wedge` | off | Also run the abandoned-lock-waiter reproduction (see below) |
| `--bootRuns` | off | Only measure `N` cold boots (time, fs ops, RSS, CPU), no load scenarios |
| `--serverArgs` | none | Extra whitespace-separated arguments appended to the server command line |

## Scenarios

1. `static-get` — `GET /` (StaticAssetHandler path).
2. `ldp-get-hot` — repeated `GET` of one small turtle resource.
3. `ldp-get-spread` — `GET` of a distinct resource per worker.
4. `ldp-put` — `PUT` of a distinct small turtle resource per worker.
5. `container-listing-100` — `GET` of a container with 100 children.
6. `idle-20s` — no requests; measures background fs activity (timer sweeps, watchers).
7. `wedge-*` (with `--wedge`) — uploads a 100 MB resource, holds its read lock with a
   trickling reader, fires 40 `PUT`s whose clients abort, then measures the *idle* fs-op
   rate for 30 s and the drain after the reader disconnects. On builds affected by the
   lock-polling bug this shows thousands of fs ops per second on an outwardly idle server.

Every scenario records: requests, errors, status codes, req/s, p50/p90/p99/max latency (ms),
fs ops (total, per request, per second), CPU seconds (user+system, from `/proc`, Linux only),
CPU ms per request, and RSS after a forced GC.

## How the fs counting works

`fs-count.js` is injected with `--require` before any application module loads, so wrappers
such as `graceful-fs`/`fs-extra` capture the counting functions. It aggregates counts per
operation, per call site (first non-internal stack frame), and per anonymized path pattern
(hashes, UUIDs and long numbers are collapsed so identical access patterns aggregate).
A snapshot is written to `FS_COUNT_OUT` every 5 s, on exit, and synchronously on `SIGUSR2`
(the runner uses `SIGUSR2` at scenario boundaries; the forced GC keeps RSS numbers honest).

It can be used on its own against any config:

```bash
FS_COUNT_OUT=/tmp/counts.json node --expose-gc --require ./scripts/perf/fs-count.js \
  bin/server.js -c config/file.json -f /tmp/pod-data
watch -n 5 "python3 -m json.tool /tmp/counts.json | head -50"
```

## Caveats — read before quoting numbers

- The load generator runs **on the same machine** as the server and `fetch` (undici)
  pools connections per origin: results are for A/B comparison between two builds on the
  same host, not absolute capacity statements.
- Scenario order is fixed and caches are deliberately warm (except `--bootRuns`);
  cold-cache behaviour is only covered by the boot measurements.
- CPU time uses `/proc/<pid>/stat` and assumes 100 Hz ticks; on non-Linux platforms the
  CPU columns are simply omitted.
- The pod setup uses a **public** ACL so the measured request path contains no token
  signing; authenticated-request performance is not covered (yet).
