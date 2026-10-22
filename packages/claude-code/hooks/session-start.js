#!/usr/bin/env node
// SessionStart hook. A hook has no MCP client, so it cannot call pending_questions itself; it
// reads the open questions the last tool response carried (lib/flush.js stores them) and hands
// them to Claude as additionalContext together with the standing instruction. It also fixes which
// connection this session uses (lib/connections.js) and, when there are several, says so. Exit 0 always.

import { fileURLToPath } from 'node:url';
import { readHookInput, failOpen } from '../lib/hook-io.js';
import { homePath, loadCredentials, readJson } from '../lib/home.js';
import { sessionPaths, sessionNote } from '../lib/connections.js';
import { buildContext } from '../lib/session-context.js';

try {
  const input = await readHookInput();
  const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
  const root = homePath();
  const p = sessionPaths(root, { sessionId });
  let context = buildContext({ credentials: loadCredentials(p), cached: readJson(p.openQuestions) });
  const note = context && sessionNote(root, p.connection, { sessionId, command: `node "${fileURLToPath(new URL('../bin/connect.js', import.meta.url))}"` });
  if (note) context += `\n${note}`;
  if (context) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`);
  }
} catch (err) {
  failOpen('session-start', err);
}
process.exitCode = 0;
