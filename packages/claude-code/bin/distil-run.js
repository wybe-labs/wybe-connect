#!/usr/bin/env node
// The distil watchdog, started detached by lib/distil.js startRun: runs the headless `claude -p` for
// one plan file, kills it after RUN_TIMEOUT_MS, and records the outcome in state/distil.json.

import { runWatchdog } from '../lib/distil.js';
import { paths } from '../lib/home.js';

const planFile = process.argv[2];
if (planFile) await runWatchdog(planFile, { paths: paths() });
