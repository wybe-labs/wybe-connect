#!/usr/bin/env node
// SessionStart hook. A hook has no MCP client, so it cannot call pending_questions itself; it
// reads the open questions the last tool response carried (lib/flush.js stores them) and hands
// them to Claude as additionalContext together with the standing instruction. Exit 0 always.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { paths, loadCredentials, readJson } from '../lib/home.js';
import { buildContext } from '../lib/session-context.js';

try {
  await readHookInput();
  const p = paths();
  const context = buildContext({ credentials: loadCredentials(p), cached: readJson(p.openQuestions) });
  if (context) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`);
  }
} catch (err) {
  failOpen('session-start', err);
}
process.exitCode = 0;
