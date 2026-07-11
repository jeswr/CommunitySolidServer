'use strict';
/**
 * Counts every `fs`/`fs.promises` call of the process it is preloaded into (`node --require`),
 * aggregated per operation, per call site, and per anonymized path pattern.
 * Writes a JSON snapshot to `FS_COUNT_OUT` every 5 seconds, on exit, and synchronously on SIGUSR2.
 * Must stay dependency-free CommonJS: it runs inside the measured server process before anything else loads.
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = process.env.FS_COUNT_OUT || path.join(process.cwd(), 'fs-count.json');
const CWD_PREFIX = `${process.cwd().replaceAll('\\', '/')}/`;
const origWriteFileSync = fs.writeFileSync.bind(fs);

const startTime = Date.now();
let total = 0;
const perOp = new Map();
const perSite = new Map();
const perPath = new Map();
// Per-second buckets (last 900 seconds)
const timeline = [];
let curSecond = -1;
let curCount = 0;

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

// Collapses ids/hashes/counters so identical access patterns aggregate
function pathPattern(p) {
  if (typeof p !== 'string') {
    if (Buffer.isBuffer(p)) {
      p = p.toString();
    } else if (p && p.href) {
      // A URL object
      p = p.href;
    } else {
      return `<${typeof p}>`;
    }
  }
  return p
    .replaceAll('\\', '/')
    .replaceAll(/[0-9a-f]{32}/giu, '<hex32>')
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '<uuid>')
    .replaceAll(/\d{4,}/gu, '<n>')
    // Keep only the tail of the path for readability
    .split('/').slice(-5).join('/');
}

function callSite() {
  const o = {};
  Error.captureStackTrace(o, callSite);
  const lines = (o.stack || '').split('\n').slice(1);
  for (const line of lines) {
    if (line.includes('fs-count.js')) {
      continue;
    }
    if (line.includes('node:internal') || line.includes('node:fs') || line.includes('node:diagnostics')) {
      continue;
    }
    return line.trim()
      .replace(/^at\s+/u, '')
      .replace(/.*node_modules\//u, 'nm:')
      .split(CWD_PREFIX).join('');
  }
  return lines[0] ? lines[0].trim() : '<unknown>';
}

function record(op, p) {
  total += 1;
  const sec = Math.floor((Date.now() - startTime) / 1000);
  if (sec !== curSecond) {
    if (curSecond >= 0) {
      timeline.push([ curSecond, curCount ]);
    }
    if (timeline.length > 900) {
      timeline.shift();
    }
    curSecond = sec;
    curCount = 0;
  }
  curCount += 1;
  bump(perOp, op);
  bump(perSite, `${op} @ ${callSite()}`);
  if (p !== undefined) {
    bump(perPath, `${op} ${pathPattern(p)}`);
  }
}

function wrap(obj, name, opName) {
  const orig = obj[name];
  if (typeof orig !== 'function') {
    return;
  }
  function wrapped(...args) {
    record(opName || name, args[0]);
    return orig.apply(this, args);
  }
  Object.defineProperty(wrapped, 'name', { value: name });
  obj[name] = wrapped;
}

const asyncAndSync = [
  'open',
  'readFile',
  'writeFile',
  'appendFile',
  'mkdir',
  'rmdir',
  'rm',
  'unlink',
  'stat',
  'lstat',
  'utimes',
  'readdir',
  'access',
  'copyFile',
  'rename',
  'realpath',
  'symlink',
  'chmod',
  'truncate',
  'opendir',
  'link',
  'readlink',
];
for (const name of asyncAndSync) {
  wrap(fs, name);
  wrap(fs, `${name}Sync`);
  wrap(fs.promises, name, `p.${name}`);
}
wrap(fs, 'createReadStream');
wrap(fs, 'createWriteStream');
wrap(fs, 'watch');
wrap(fs, 'watchFile');
wrap(fs, 'exists');
wrap(fs, 'existsSync');

function top(map, n) {
  return [ ...map.entries() ].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function snapshot(forceGc) {
  if (forceGc && typeof globalThis.gc === 'function') {
    try {
      globalThis.gc();
      globalThis.gc();
    } catch {}
  }
  const uptimeSec = (Date.now() - startTime) / 1000;
  const data = {
    pid: process.pid,
    uptimeSec: Math.round(uptimeSec),
    total,
    rssMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    perOp: Object.fromEntries(top(perOp, 30)),
    perSite: Object.fromEntries(top(perSite, 40)),
    perPath: Object.fromEntries(top(perPath, 30)),
    timeline: timeline.slice(-240),
  };
  try {
    origWriteFileSync(OUT, JSON.stringify(data, null, 2));
  } catch {}
}

const iv = setInterval(snapshot, 5000);
iv.unref();
process.on('exit', snapshot);
// On-demand synchronous dump for benchmark scenario boundaries
process.on('SIGUSR2', () => snapshot(true));
