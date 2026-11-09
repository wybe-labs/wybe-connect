#!/usr/bin/env node
// Codex SessionStart / Stop / SessionEnd: the session bridge (lib/task-poller.js, lib/bridge.js).
// SessionStart (and any Stop, when it is gone) starts the session's detached poller, which queues a
// task into the live session with `codex queue`. Stop settles the result of the task the turn
// worked on and, when a notice could not be queued, prints {"decision":"block","reason":...} once.
// SessionEnd marks the session closed and leaves at once. Exit 0 always.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { codexHook } from '../lib/task-poller.js';

try {
  const out = await codexHook(await readHookInput());
  if (out) process.stdout.write(out);
} catch (err) {
  failOpen('bridge', err);
}
process.exitCode = 0;
