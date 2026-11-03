#!/usr/bin/env node
// Runs every check from this machine and prints the result. Writes nothing.
const { runChecks, loadConfig } = require('../lambda/checker');

runChecks(loadConfig(), {}, { retryDelayMs: 500 }).then((apps) => {
  for (const app of apps) {
    console.log(`${app.status.padEnd(9)} ${app.key}`);
    for (const fn of app.functions) console.log(`  ${fn.status.padEnd(9)} ${fn.name}: ${fn.detail}`);
  }
});
