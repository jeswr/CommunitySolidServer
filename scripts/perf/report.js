'use strict';
/**
 * Renders one or more runner result files as a markdown comparison.
 *
 * Usage: node scripts/perf/report.js baseline.json [candidate.json ...]
 *
 * The first file is the baseline: for every numeric metric the other columns
 * show the relative difference against it. "Better" is metric-dependent
 * (higher rps, lower latency/fs ops/CPU/RSS), so no coloring is applied;
 * the deltas are informational.
 */
const fs = require('node:fs');

const METRICS = [ 'rps', 'p50', 'p90', 'p99', 'errors', 'fsOps', 'fsOpsPerReq', 'fsOpsPerSec', 'cpuSec', 'cpuMsPerReq', 'rssMB' ];

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node report.js <results.json> [more.json ...]');
  process.exit(1);
}
const runs = files.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
const labels = runs.map((run, i) => run.label || `run${i}`);

function delta(base, value) {
  if (typeof base !== 'number' || typeof value !== 'number' || base === 0) {
    return '';
  }
  const pct = Math.round(((value - base) / base) * 1000) / 10;
  return ` (${pct > 0 ? '+' : ''}${pct}%)`;
}

function cell(base, value) {
  if (value === undefined || value === null) {
    return '—';
  }
  return `${value}${base === value ? '' : delta(base, value)}`;
}

function table(header, rows) {
  const lines = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

const out = [];
out.push(`# Benchmark comparison: ${labels.join(' vs ')}`, '');
out.push(`Config: ${runs[0].config} — Node ${runs[0].node} — host ${JSON.stringify(runs[0].host || {})}`, '');

// Boot
const bootRows = [];
for (const metric of [ 'ms', 'medianMs', 'fsOps', 'rssMB', 'cpuSec' ]) {
  const values = runs.map(run => run.boot?.[metric]);
  if (values.every(value => value === undefined)) {
    continue;
  }
  bootRows.push([ metric, ...values.map(value => cell(values[0], value)) ]);
}
if (bootRows.length > 0) {
  out.push('## Boot', '', table([ 'metric', ...labels ], bootRows), '');
}

// Scenarios
const names = [ ...new Set(runs.flatMap(run => Object.keys(run.scenarios || {}))) ];
for (const name of names) {
  const rows = [];
  for (const metric of METRICS) {
    const values = runs.map(run => run.scenarios?.[name]?.[metric]);
    if (values.every(value => value === undefined)) {
      continue;
    }
    rows.push([ metric, ...values.map(value => cell(values[0], value)) ]);
  }
  out.push(`## ${name}`, '', table([ 'metric', ...labels ], rows), '');
}

console.log(out.join('\n'));
