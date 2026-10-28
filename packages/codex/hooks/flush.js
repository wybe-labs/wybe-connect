#!/usr/bin/env node
// Codex Stop / PreCompact / SessionEnd hook: flush the redacted rollout delta to the node.
// stdin (codex-rs/hooks/schema/generated/*.command.input.schema.json): { session_id,
// transcript_path (the rollout, or null), cwd, hook_event_name, model, turn_id?, agent_id?, ... }.
// `--offline` (SessionEnd, capped at 3 s by Codex) builds and queues without the network.
// Prints nothing on stdout (Codex parses stdout as hook output). Exit 0 always.

import { readHookInput, failOpen, queueNotice } from '../lib/hook-io.js';
import { flush } from '../lib/flush.js';
import { harnessHome } from '../lib/home.js';
import { connectionNames, connectionPaths, sessionLines, sessionPaths } from '../lib/connections.js';

try {
  const input = await readHookInput();
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'Stop';
  // A PreCompact inside a spawned subagent carries agent_id: that thread is not the person's.
  if (typeof input.agent_id !== 'string') {
    const root = harnessHome('codex');
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : null;
    const paths = sessionPaths(root, { sessionId, transcriptPath });
    const offline = process.argv.includes('--offline') || event === 'SessionEnd';
    // Each connection gets only the lines the session wrote while on it: a move leaves the earlier ones to the
    // connection it left, sent from that connection's own cursor.
    const flushTo = (p) => flush({ harness: 'codex', paths: p, lines: sessionLines(root, sessionId, p.connection), transcriptPath, sessionId, cwd: typeof input.cwd === 'string' ? input.cwd : null, event, offline });
    for (const k of connectionNames(root)) {
      if (k !== paths.connection && sessionLines(root, sessionId, k)?.length) await flushTo(connectionPaths(root, k));
    }
    const summary = await flushTo(paths);
    if (summary.lastOutcome?.kind !== 'offline') process.stderr.write(queueNotice(summary));
  }
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
