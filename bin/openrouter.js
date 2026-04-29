#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv.slice(2)).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  if (process.env.OPENROUTER_DEBUG && err && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exit(err && typeof err.exitCode === 'number' ? err.exitCode : 1);
});
