import opinionated from 'opinionated-eslint-config';

export default opinionated().append({
  // Don't want to lint test assets
  ignores: [ 'test/assets/*', 'componentsjs-error-state.json', '.data/**' ],
}).append({
  // The performance harness scripts are standalone CLI tools
  files: [ 'scripts/perf/**/*.js' ],
  rules: {
    'no-console': 'off',
    'no-sync': 'off',
    'unicorn/no-process-exit': 'off',
  },
});
