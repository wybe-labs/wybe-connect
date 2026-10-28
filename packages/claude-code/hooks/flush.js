#!/usr/bin/env node
// Stop / SessionEnd / PreCompact hook (Claude Code). It sends nothing itself: «essence only»
// (Oscar 2026-10-21, relayed in #4). It notes the session's transcript for the background distil
// (lib/distil.js) and lets the scheduler start a run when one is due. Inside a distil run it does
// nothing. stdin: { session_id, transcript_path, cwd, hook_event_name, ... }. Exit 0 always.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { paths, harnessHome } from '../lib/home.js';
import { DISTIL_ENV, noteSession, maybeRun } from '../lib/distil.js';

try {
  const input = await readHookInput();
  if (!process.env[DISTIL_ENV]) {
    const p = paths(harnessHome('claude-code'));
    noteSession(p, {
      transcriptPath: input.transcript_path,
      sessionId: typeof input.session_id === 'string' ? input.session_id : null,
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
    });
    maybeRun({ paths: p });
  }
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
