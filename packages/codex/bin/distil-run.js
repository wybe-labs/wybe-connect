#!/usr/bin/env node
// The detached watchdog for one background distil (lib/distil.js runWatchdog): runs the headless
// `codex exec`, ends its process tree at 30 minutes, then delivers the run's outbox to the node of
// the connection the run was planned for. argv: <plan file>. Started by maybeRun; prints nothing.

import { runWatchdog, planPaths } from '../lib/distil.js';
import { harnessHome, readJson } from '../lib/home.js';

const planFile = process.argv[2];
if (planFile) {
  try {
    const p = planPaths(readJson(planFile), harnessHome('codex'));
    if (p) await runWatchdog(planFile, { paths: p });
  } catch {
    // the scheduler sees a dead watchdog and settles the run
  }
}
process.exitCode = 0;
