#!/usr/bin/env node
// The session bridge's detached helper (lib/task-poller.js binMain), started by the hooks:
//   poll --harness codex --session <id>      the Codex session's poller; queues tasks with `codex queue`
//   report --harness <h> --session <id>      one sessions_report (the closing one after SessionEnd)
// Prints nothing. Exit 0.

import { binMain } from '../lib/task-poller.js';

try {
  await binMain(process.argv.slice(2));
} catch {
  // detached: nobody reads its output; the next hook starts again
}
process.exit(0);
