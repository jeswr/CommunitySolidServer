'use strict';
/**
 * CSS benchmark runner. Boots a server build with the fs-count preload,
 * drives a fixed set of scenarios against it, and records throughput,
 * latency percentiles, file-system-operation and CPU-time deltas, and RSS.
 *
 * Usage:
 *   node scripts/perf/runner.js --serverDir <builtCheckout>
 *     [--config config/file.json] [--port 3460] [--label name] [--out results.json]
 *     [--seconds 10] [--conc 20] [--wedge] [--bootRuns N]
 *     [--serverArgs "--extraFlag value ..."]
 *
 * --serverDir must point at a *built* CSS checkout (bin/server.js present);
 *   `jose` is resolved from that checkout's dependency tree for the pod setup.
 * --wedge additionally reproduces the abandoned-lock-waiter scenario
 *   (a trickling reader holding a read lock + 40 aborted writers) and
 *   measures the idle fs-op rate it leaves behind.
 * --bootRuns N only measures cold-boot time/IO/RSS N times (no scenarios).
 * --serverArgs appends extra whitespace-separated arguments to the server
 *   command line (e.g. "--moduleStateCachePath /tmp/ms.json").
 *
 * All numbers are indicative: the load generator shares the machine with the
 * server, and `fetch` (undici) pools connections per origin.
 */
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { load } = require('./loadgen');
const { setupPod } = require('./bench-setup');

const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        i += 1;
        args[key] = argv[i];
      } else {
        args[key] = true;
      }
    }
  }
}

if (!args.serverDir) {
  console.error('Missing required --serverDir <path to built CSS checkout>');
  process.exit(1);
}

const SERVER_DIR = path.resolve(args.serverDir);
const CONFIG = args.config || 'config/file.json';
const PORT = Number(args.port || 3460);
const LABEL = args.label || 'run';
const SECONDS = Number(args.seconds || 10);
const CONC = Number(args.conc || 20);
const OUT = args.out || `${LABEL}.json`;
const BASE = `http://localhost:${PORT}/`;
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), `css-bench-${LABEL}-`));
const COUNTS = path.join(WORKDIR, 'fs-count.json');

const serverRequire = createRequire(path.join(SERVER_DIR, 'noop.js'));
const jose = serverRequire('jose');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let server;
let serverLog = '';

async function startServer(podDir) {
  fs.mkdirSync(podDir, { recursive: true });
  serverLog = '';
  const t0 = Date.now();
  server = spawn(process.execPath, [
    '--expose-gc',
    '--require',
    path.join(__dirname, 'fs-count.js'),
    'bin/server.js',
    '-c',
    CONFIG,
    '-f',
    podDir,
    '-p',
    String(PORT),
    '-l',
    'warn',
    ...typeof args.serverArgs === 'string' ? args.serverArgs.split(/\s+/u).filter(Boolean) : [],
  ], {
    cwd: SERVER_DIR,
    env: { ...process.env, FS_COUNT_OUT: COUNTS },
    stdio: [ 'ignore', 'pipe', 'pipe' ],
  });
  server.stdout.on('data', (data) => {
    serverLog += data;
  });
  server.stderr.on('data', (data) => {
    serverLog += data;
  });
  const deadline = Date.now() + 120000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`Server did not start.\n${serverLog.slice(-2000)}`);
    }
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      await res.arrayBuffer();
      if (res.status < 500) {
        break;
      }
    } catch {}
    await sleep(500);
  }
  return Date.now() - t0;
}

function stopServer(signal = 'SIGINT') {
  // Capture the current process: the module-level variable may already
  // point at the next boot's process by the time the escalation fires.
  const proc = server;
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve();
      return;
    }
    // Escalate if a graceful stop hangs
    const escalation = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }, 10000);
    escalation.unref();
    proc.once('exit', () => {
      clearTimeout(escalation);
      resolve();
    });
    proc.kill(signal);
  });
}

// Snapshot of the fs-count preload's counters (forces a dump via SIGUSR2)
function counters() {
  try {
    process.kill(server.pid, 'SIGUSR2');
  } catch {}
  return sleep(400).then(() => JSON.parse(fs.readFileSync(COUNTS, 'utf8')));
}

// Cumulative CPU seconds (user+system) of the server process; Linux only
function cpuSeconds() {
  try {
    const stat = fs.readFileSync(`/proc/${server.pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // Fields 14 (utime) and 15 (stime), in USER_HZ ticks (assumed 100 Hz)
    return (Number(rest[11]) + Number(rest[12])) / 100;
  } catch {}
}

async function scenario(name, results, fn) {
  const before = await counters();
  const cpuBefore = cpuSeconds();
  const t0 = Date.now();
  const stats = await fn();
  const after = await counters();
  const cpuAfter = cpuSeconds();
  const fsOps = after.total - before.total;
  const durSec = (Date.now() - t0) / 1000;
  const cpuSec = cpuAfter !== undefined && cpuBefore !== undefined ?
    Math.round((cpuAfter - cpuBefore) * 100) / 100 :
    undefined;
  results.scenarios[name] = {
    ...stats,
    fsOps,
    fsOpsPerReq: stats && stats.requests ? Math.round((fsOps / stats.requests) * 100) / 100 : undefined,
    fsOpsPerSec: Math.round(fsOps / durSec),
    cpuSec,
    cpuMsPerReq: cpuSec !== undefined && stats && stats.requests ?
      Math.round((cpuSec * 1000 / stats.requests) * 100) / 100 :
      undefined,
    rssMB: after.rssMB,
  };
  console.log(`[${LABEL}] ${name}: ${JSON.stringify(results.scenarios[name])}`);
}

const TTL_BODY = '@prefix ex: <http://example.org/> .\nex:s ex:p "hello", "world" ; ex:q 42 .\n';

function idle(seconds) {
  return async() => {
    await sleep(seconds * 1000);
    return { requests: 0, errors: 0, codes: {}, rps: 0 };
  };
}

async function runWedge(results, scratch) {
  // A 100 MB resource, a slow reader holding the read lock, and 40 writers
  // whose clients abort: on an affected build the abandoned waiters keep
  // polling the disk although the server is outwardly idle.
  const big = Buffer.alloc(100 * 1024 * 1024, 7);
  await fetch(`${scratch}big.bin`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: big });
  const res = await fetch(`${scratch}big.bin`);
  const reader = res.body.getReader();
  const state = { trickling: true };
  const trickler = (async() => {
    while (state.trickling) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
      await sleep(2000);
    }
    try {
      await reader.cancel();
    } catch {}
  })();
  await sleep(1000);
  const writers = [];
  for (let i = 0; i < 40; i++) {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    writers.push(fetch(`${scratch}big.bin`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'abandoned',
      signal: ac.signal,
    }).catch(() => {}));
  }
  await Promise.all(writers);
  await scenario('wedge-40-abandoned-writers-30s', results, idle(30));
  state.trickling = false;
  try {
    await reader.cancel();
  } catch {}
  await trickler.catch(() => {});
  await scenario('wedge-drain-15s', results, idle(15));
}

async function main() {
  const results = {
    label: LABEL,
    serverDir: SERVER_DIR,
    config: CONFIG,
    node: process.version,
    host: { platform: os.platform(), cpus: os.cpus().length, totalMemMB: Math.round(os.totalmem() / 1024 / 1024) },
    scenarios: {},
  };

  // Cold-boot measurement mode: N fresh boots, no load scenarios
  if (args.bootRuns) {
    const runs = [];
    for (let i = 0; i < Number(args.bootRuns); i++) {
      const ms = await startServer(path.join(WORKDIR, `pod-data-${i}`));
      const counts = await counters();
      const cpuSec = cpuSeconds();
      runs.push({ ms, fsOps: counts.total, rssMB: counts.rssMB, cpuSec });
      console.log(`[${LABEL}] boot ${i}: ${JSON.stringify(runs[i])}`);
      await stopServer();
    }
    const sorted = [ ...runs ].sort((a, b) => a.ms - b.ms);
    results.boot = { runs, medianMs: sorted[Math.floor(sorted.length / 2)].ms };
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`[${LABEL}] written ${OUT}`);
    return;
  }

  const bootMs = await startServer(path.join(WORKDIR, 'pod-data'));
  const bootCounts = await counters();
  results.boot = { ms: bootMs, fsOps: bootCounts.total, rssMB: bootCounts.rssMB, cpuSec: cpuSeconds() };
  console.log(`[${LABEL}] boot: ${JSON.stringify(results.boot)}`);

  const pod = await setupPod({ baseUrl: BASE, jose, containers: [ 'scratch/', 'listing/' ]});
  const { scratch, listing } = pod.containers;

  // Pre-create resources: 20 hot/spread targets + 100 listing children
  for (let i = 0; i < 20; i++) {
    await fetch(`${scratch}res-${i}.ttl`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: TTL_BODY });
  }
  for (let i = 0; i < 100; i++) {
    await fetch(`${listing}child-${i}.ttl`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: TTL_BODY });
  }

  const opts = { conc: CONC, seconds: SECONDS };
  await scenario('static-get', results, () => load({ url: BASE, ...opts }));
  await scenario('ldp-get-hot', results, () => load({ url: `${scratch}res-0.ttl`, ...opts }));
  await scenario('ldp-get-spread', results, () => load({ url: `${scratch}res-%i.ttl`, ...opts }));
  await scenario('ldp-put', results, () => load({ url: `${scratch}put-%i.ttl`, method: 'PUT', body: TTL_BODY, contentType: 'text/turtle', ...opts }));
  await scenario('container-listing-100', results, () => load({ url: listing, conc: 10, seconds: SECONDS }));
  await scenario('idle-20s', results, idle(20));

  if (args.wedge) {
    await runWedge(results, scratch);
  }

  const final = await counters();
  results.final = {
    totalFsOps: final.total,
    rssMB: final.rssMB,
    topSites: Object.fromEntries(Object.entries(final.perSite).slice(0, 15)),
  };

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`[${LABEL}] written ${OUT}`);
}

main().then(
  async() => {
    await stopServer();
    process.exit(0);
  },
  async(err) => {
    console.error(err);
    await stopServer('SIGKILL');
    process.exit(1);
  },
);
