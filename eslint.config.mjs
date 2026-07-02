import opinionated from 'opinionated-eslint-config';

export default opinionated().append({
  // Don't want to lint test assets
  ignores: [ 'test/assets/*', 'componentsjs-error-state.json', '.data/**' ],
}).append({
  // The performance harness consists of standalone CLI tools:
  // console output is their interface, synchronous fs calls and process.exit are fine there,
  // and fs-count.js must stay dependency-free CommonJS as it is preloaded into the measured server process.
  files: [ 'scripts/perf/**/*.js' ],
  rules: {
    'no-console': 'off',
    'no-sync': 'off',
    'unicorn/no-process-exit': 'off',
  },
});
