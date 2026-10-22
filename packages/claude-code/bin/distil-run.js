#!/usr/bin/env node
// The detached watchdog for one background distil (lib/distil.js runWatchdog): runs the headless
// claude, ends its process tree at 30 minutes, then delivers the run's outbox to the node.
// argv: <plan file>. Started by maybeRun; prints nothing.

import { runWatchdog } from '../lib/distil.js';
import { paths, harnessHome } from '../lib/home.js';

const planFile = process.argv[2];
if (planFile) {
  try {
    await runWatchdog(planFile, { paths: paths(harnessHome('claude-code')) });
  } catch {
    // the scheduler sees a dead watchdog and settles the run
  }
}
process.exitCode = 0;
