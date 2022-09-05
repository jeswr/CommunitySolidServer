
const options = require('../.markdownlint-cli2.cjs');
"use strict";

module.exports = {
  globs: [ "**/*.md" ],
  config: {
    // Re-use the base config
    ...options.config,

    // Allow first line to not be top level heading
    MD041: false
  }
};
