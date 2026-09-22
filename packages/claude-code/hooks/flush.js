#!/usr/bin/env node
// Stop / SessionEnd / PreCompact hook: flush the redacted transcript delta to the node.
// stdin: { session_id, transcript_path, cwd, hook_event_name, ... }. Exit 0 always.

import { readHookInput, failOpen } from './hook-input.js';
import { flush } from '../lib/flush.js';

try {
  const input = await readHookInput();
  const summary = await flush({
    transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
    sessionId: typeof input.session_id === 'string' ? input.session_id : null,
    cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
    event: typeof input.hook_event_name === 'string' ? input.hook_event_name : 'Stop',
  });
  if (summary.queued > 0 || (summary.queue && summary.queue.count > 0)) {
    process.stderr.write(`wybe-connect: node not reachable (${summary.lastOutcome?.kind ?? 'unknown'}); ${summary.queue.count} delta(s) queued locally\n`);
  }
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
