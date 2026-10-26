#!/usr/bin/env node
// Stop / SessionEnd / PreCompact hook (Claude Code). It sends nothing itself: essence only. It
// notes the session's transcript for the background distil (lib/distil.js) of the connection this
// session uses (lib/connections.js) and lets the scheduler start a run when one is due. Without a
// connection, or inside a distil run, it does nothing.
// stdin: { session_id, transcript_path, cwd, hook_event_name, ... }. Exit 0 always.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { homePath } from '../lib/home.js';
import { sessionPaths } from '../lib/connections.js';
import { DISTIL_ENV, noteSession, maybeRun } from '../lib/distil.js';

try {
  const input = await readHookInput();
  if (!process.env[DISTIL_ENV]) {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const p = sessionPaths(homePath(), { sessionId });
    if (p.connection) {
      noteSession(p, {
        transcriptPath: input.transcript_path,
        sessionId,
        cwd: typeof input.cwd === 'string' ? input.cwd : null,
      });
      maybeRun({ paths: p });
    }
  }
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
