#!/usr/bin/env node
// SessionStart hook. A hook has no MCP client, so it cannot call pending_questions itself; it
// reads the open questions the last tool response carried (the plugin's MCP server stores them)
// and hands them to Claude as additionalContext together with the standing instruction. A
// background distil problem is told once per kind (lib/distil.js distilNotice). Exit 0 always.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { paths, harnessHome, loadCredentials, readJson } from '../lib/home.js';
import { buildContext } from '../lib/session-context.js';
import { DISTIL_ENV, distilNotice } from '../lib/distil.js';

try {
  await readHookInput();
  if (!process.env[DISTIL_ENV]) {
    const p = paths(harnessHome('claude-code'));
    const credentials = loadCredentials(p);
    const context = buildContext({ credentials, cached: readJson(p.openQuestions) });
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
