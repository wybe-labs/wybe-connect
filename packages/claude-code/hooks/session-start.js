#!/usr/bin/env node
// SessionStart hook. A hook has no MCP client, so it cannot call pending_questions itself; it
// reads the open questions the last tool response carried (the plugin's MCP server stores them)
// and hands them to Claude as additionalContext together with the standing instruction. It also
// fixes which connection this session uses (lib/connections.js) and, when there are several, says
// so. A background distil problem of that connection is told once per kind (lib/distil.js
// distilNotice). Exit 0 always.

import { fileURLToPath } from 'node:url';
import { readHookInput, failOpen } from '../lib/hook-io.js';
import { homePath, loadCredentials, readJson } from '../lib/home.js';
import { sessionPaths, sessionNote } from '../lib/connections.js';
import { buildContext } from '../lib/session-context.js';
import { DISTIL_ENV, distilNotice } from '../lib/distil.js';

try {
  const input = await readHookInput();
  if (!process.env[DISTIL_ENV]) {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const root = homePath();
    const p = sessionPaths(root, { sessionId });
    const credentials = loadCredentials(p);
    let context = buildContext({ credentials, cached: readJson(p.openQuestions) });
    const note = sessionNote(root, p.connection, { sessionId, command: `node "${fileURLToPath(new URL('../bin/connect.js', import.meta.url))}"` });
    context = [context, note].filter(Boolean).join('\n');
    const notice = credentials ? distilNotice(p) : null;
    const all = [context, notice].filter(Boolean).join('\n');
    if (all) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: all } })}\n`);
    }
  }
} catch (err) {
  failOpen('session-start', err);
}
process.exitCode = 0;
