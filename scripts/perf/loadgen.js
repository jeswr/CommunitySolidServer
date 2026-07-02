'use strict';
/**
 * Minimal dependency-free HTTP load generator built on global fetch.
 *
 * As a module: `const { load } = require('./loadgen');`
 * As a CLI:    node loadgen.js <url> [concurrency] [seconds] [method] [bodyFile] [contentType]
 *
 * A literal `%i` in the URL is replaced by the worker index, so concurrent
 * workers can target distinct resources (e.g. `.../res-%i.ttl`).
 */
const { readFileSync } = require('node:fs');

/**
 * Drives `conc` concurrent workers against `url` for `seconds` seconds.
 * Returns { requests, errors, codes, durationSec, rps, p50, p90, p99, max }
 * with latencies in milliseconds.
 */
async function load({ url, method = 'GET', body, contentType, conc = 20, seconds = 10 }) {
  const deadline = Date.now() + seconds * 1000;
  let done = 0;
  let errors = 0;
  const codes = {};
  const latencies = [];

  async function worker(i) {
    const target = url.includes('%i') ? url.replace('%i', String(i)) : url;
    while (Date.now() < deadline) {
      const t0 = process.hrtime.bigint();
      try {
        const res = await fetch(target, {
          method,
          body,
          headers: contentType ? { 'content-type': contentType } : undefined,
        });
        await res.arrayBuffer();
        codes[res.status] = (codes[res.status] || 0) + 1;
      } catch {
        errors += 1;
      }
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
      done += 1;
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, (_, i) => worker(i)));
  const durationSec = (Date.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  function pct(p) {
    return Math.round((latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] || 0) * 100) / 100;
  }
  return {
    requests: done,
    errors,
    codes,
    durationSec: Math.round(durationSec * 10) / 10,
    rps: Math.round(done / durationSec),
    p50: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    max: Math.round((latencies.at(-1) || 0) * 100) / 100,
  };
}

module.exports = { load };

if (require.main === module) {
  const [ url, concurrency = '20', seconds = '10', method = 'GET', bodyFile, contentType ] = process.argv.slice(2);
  if (!url) {
    console.error('Usage: node loadgen.js <url> [concurrency] [seconds] [method] [bodyFile] [contentType]');
    process.exit(1);
  }
  const body = bodyFile ? readFileSync(bodyFile) : undefined;
  load({ url, method, body, contentType, conc: Number(concurrency), seconds: Number(seconds) })
    .then(stats => console.log(JSON.stringify(stats, null, 2)));
}
