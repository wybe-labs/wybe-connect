#!/usr/bin/env node
// Stop / SessionEnd / PreCompact hook: flush the redacted transcript delta to the node.
// stdin: { session_id, transcript_path, cwd, hook_event_name, ... }. Exit 0 always.

import { readHookInput, failOpen, queueNotice } from '../lib/hook-io.js';
import { flush } from '../lib/flush.js';

try {
  const input = await readHookInput();
  const summary = await flush({
    transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
    sessionId: typeof input.session_id === 'string' ? input.session_id : null,
    cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
    event: typeof input.hook_event_name === 'string' ? input.hook_event_name : 'Stop',
  });
  process.stderr.write(queueNotice(summary));
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
