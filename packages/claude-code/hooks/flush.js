#!/usr/bin/env node
// Stop / SessionEnd / PreCompact hook. Essence only (Oscar, 21.10): nothing from the transcript is
// sent from here. The hook notes the transcript for the next distil run (lib/distil.js) and starts
// that run when it is due; the run sends only a short list of durable work facts with `remember`.
// stdin: { session_id, transcript_path, cwd, hook_event_name, ... }. Exit 0 always, and silent.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { paths, loadCredentials } from '../lib/home.js';
import { inDistilRun, noteSession, maybeRun } from '../lib/distil.js';

try {
  const input = await readHookInput();
  const p = paths();
  const credentials = loadCredentials(p);
  // The distil run sends with `remember`; a grant without it has nothing to distil for.
  if (!inDistilRun() && credentials?.scopes.includes('remember')) {
    noteSession(p, {
      transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
      sessionId: typeof input.session_id === 'string' ? input.session_id : null,
      cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
    });
    maybeRun({ paths: p });
  }
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
