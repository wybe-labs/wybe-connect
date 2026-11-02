#!/usr/bin/env node
// Codex Stop / PreCompact / SessionEnd hook. It sends nothing itself: essence only. It notes the
// session's rollout for the background distil (lib/distil.js) of the connection this session uses
// (lib/connections.js), then lets the scheduler of every connection start a `codex exec` run when
// one is due (another connection's outbox may still wait to be delivered). Inside a distil run it
// does nothing.
// stdin (codex-rs/hooks/schema/generated/*.command.input.schema.json): { session_id,
// transcript_path (the rollout, or null), cwd, hook_event_name, model, turn_id?, agent_id?, ... }.
// A spawned subagent's thread (agent_id, or a subagent/internal source in session_meta) and a
// compressed rollout are not noted. `--offline` (SessionEnd, capped at 3 s by Codex) only notes;
// the next Stop starts the run. Prints nothing on stdout (Codex parses stdout as hook output).
// Exit 0 always.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { harnessHome } from '../lib/home.js';
import { sessionPaths } from '../lib/connections.js';
import { accountOf } from '../lib/session-info.js';
import { rolloutHead } from '../lib/codex-rollout.js';
import { DISTIL_ENV, noteSession, maybeRunAll } from '../lib/distil.js';

const personRollout = (path) => {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return false;
  try {
    return rolloutHead(path)?.personThread === true;
  } catch {
    return false;
  }
};

try {
  const input = await readHookInput();
  if (!process.env[DISTIL_ENV] && typeof input.agent_id !== 'string') {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const root = harnessHome('codex');
    const p = sessionPaths(root, { sessionId, transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null, account: () => accountOf('codex') });
    if (p.connection && personRollout(input.transcript_path)) {
      noteSession(p, {
        transcriptPath: input.transcript_path,
        sessionId,
        cwd: typeof input.cwd === 'string' ? input.cwd : null,
      });
    }
    const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'Stop';
    if (!process.argv.includes('--offline') && event !== 'SessionEnd') maybeRunAll(root, { harness: 'codex' });
  }
} catch (err) {
  failOpen('flush', err);
}
process.exitCode = 0;
