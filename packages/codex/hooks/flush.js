#!/usr/bin/env node
// Codex Stop / PreCompact / SessionEnd hook: flush the redacted rollout delta to the node.
// stdin (codex-rs/hooks/schema/generated/*.command.input.schema.json): { session_id,
// transcript_path (the rollout, or null), cwd, hook_event_name, model, turn_id?, agent_id?, ... }.
// `--offline` (SessionEnd, capped at 3 s by Codex) builds and queues without the network.
// Prints nothing on stdout (Codex parses stdout as hook output). Exit 0 always.

import { readHookInput, failOpen, queueNotice } from '../lib/hook-io.js';
import { flush } from '../lib/flush.js';
import { harnessHome } from '../lib/home.js';
import { sessionPaths } from '../lib/connections.js';

try {
  const input = await readHookInput();
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'Stop';
  // A PreCompact inside a spawned subagent carries agent_id: that thread is not the person's.
  if (typeof input.agent_id !== 'string') {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const summary = await flush({
      harness: 'codex',
      paths: sessionPaths(harnessHome('codex'), { sessionId, transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null }),
      transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
      sessionId,
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      event,
      offline: process.argv.includes('--offline') || event === 'SessionEnd',
    });
    if (summary.lastOutcome?.kind !== 'offline') process.stderr.write(queueNotice(summary));
  }
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
