#!/usr/bin/env node
// Stop / SessionEnd / PreCompact hook (Claude Code). It sends nothing itself: essence only. It
// notes the session's transcript for the background distil (lib/distil.js) of the connection this
// session uses (lib/connections.js), then lets the scheduler of every connection start a run when
// one is due (another connection's outbox may still wait to be delivered). Inside a distil run it
// does nothing. stdin: { session_id, transcript_path, cwd, hook_event_name, ... }. Exit 0 always.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { homePath } from '../lib/home.js';
import { sessionPaths } from '../lib/connections.js';
import { DISTIL_ENV, noteSession, maybeRunAll } from '../lib/distil.js';

try {
  const input = await readHookInput();
  if (!process.env[DISTIL_ENV]) {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const root = homePath();
    const p = sessionPaths(root, { sessionId });
    if (p.connection) {
      noteSession(p, {
        transcriptPath: input.transcript_path,
        sessionId,
        cwd: typeof input.cwd === 'string' ? input.cwd : null,
      });
    }
    maybeRunAll(root);
  }
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
