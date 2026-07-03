#!/usr/bin/env node
const { AppRunner } = require('..');

// Attaching a logger to the uncaughtExceptionMonitor event,
// such that the default uncaughtException behavior still occurs.
process.on('uncaughtExceptionMonitor', (err, origin) => {
  // eslint-disable-next-line no-console
  console.error(`Process is halting due to an ${origin} with error ${err.message}`);
});

// Validates the configuration without starting the server; exits 0 if valid, non-zero otherwise.
// eslint-disable-next-line no-sync
new AppRunner().validateCliSync(process);
