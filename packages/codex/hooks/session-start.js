#!/usr/bin/env node
// Codex SessionStart hook. A hook has no MCP client, so it cannot call pending_questions itself;
// it reads the open questions the last tool response carried (the plugin's MCP server stores them) and hands
// them to the model with the standing instruction, in the output shape of
// codex-rs/hooks/schema/generated/session-start.command.output.schema.json. It also fixes which
// connection this session uses (lib/connections.js) and, when there are several, says so. A
// background distil problem of that connection is told once per kind (lib/distil.js
// distilNotice). Inside a distil run it does nothing. Exit 0 always.

import { fileURLToPath } from 'node:url';
import { readHookInput, failOpen } from '../lib/hook-io.js';
import { harnessHome, loadCredentials, readJson } from '../lib/home.js';
import { prunePins, sessionPaths, sessionNote } from '../lib/connections.js';
import { buildContext } from '../lib/session-context.js';
import { DISTIL_ENV, codexHomeOf, distilNotice } from '../lib/distil.js';

try {
  const input = await readHookInput();
  if (!process.env[DISTIL_ENV]) {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const root = harnessHome('codex');
    // this session first, so pruning the others can never reset it; a rollout compressed or archived under
    // CODEX_HOME keeps its session's pin
    const p = sessionPaths(root, { sessionId, transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null });
    prunePins(root, { exceptSessionId: sessionId, codexHome: codexHomeOf(process.env) });
    const credentials = loadCredentials(p);
    let context = buildContext({ credentials, cached: readJson(p.openQuestions) });
    const note = sessionNote(root, p.connection, { sessionId, command: `node "${fileURLToPath(new URL('../bin/connect.js', import.meta.url))}"` });
    context = [context, note].filter(Boolean).join('\n');
    const notice = credentials ? distilNotice(p, { harness: 'codex' }) : null;
    const all = [context, notice].filter(Boolean).join('\n');
    if (all) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: all } })}\n`);
    }
  }
} catch (err) {
  failOpen('session-start', err);
}
process.exitCode = 0;
