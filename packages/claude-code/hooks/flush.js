#!/usr/bin/env node
// Stop / SessionEnd / PreCompact hook: flush the redacted transcript delta to the node this
// session uses (lib/connections.js). stdin: { session_id, transcript_path, cwd, hook_event_name, ... }.
// Exit 0 always.

import { readHookInput, failOpen, queueNotice } from '../lib/hook-io.js';
import { flush } from '../lib/flush.js';
import { homePath } from '../lib/home.js';
import { sessionPaths } from '../lib/connections.js';

try {
  const input = await readHookInput();
  const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
  const summary = await flush({
    paths: sessionPaths(homePath(), { sessionId }),
    transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
    sessionId,
    cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
    event: typeof input.hook_event_name === 'string' ? input.hook_event_name : 'Stop',
  });
  process.stderr.write(queueNotice(summary));
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
