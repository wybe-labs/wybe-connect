#!/usr/bin/env node
// Tasks from the person's Wybe colleague into this live session (lib/task-poller.js, lib/bridge.js).
// An `asyncRewake` hook on SessionStart, Stop and StopFailure: it runs in the background as the
// session's poller and exits 2 with the notice on stderr when a task arrives, which wakes Claude.
// Stop and StopFailure first settle the result of the task the turn worked on. UserPromptSubmit
// pauses the poller; SessionEnd marks the session closed and leaves at once. Otherwise exit 0,
// quietly: a superseded poller, no connection, or any failure.

import { readHookInput } from '../lib/hook-io.js';
import { claudeHook } from '../lib/task-poller.js';

let code = 0;
try {
  code = await claudeHook(await readHookInput());
} catch {
  code = 0;
}
await new Promise((r) => process.stderr.write('', r));
process.exit(code);
