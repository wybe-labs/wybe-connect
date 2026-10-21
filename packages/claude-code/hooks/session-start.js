#!/usr/bin/env node
// SessionStart hook. A hook has no MCP client, so it cannot call pending_questions itself; it
// reads the open questions the last tool response carried (lib/flush.js stores them) and hands
// them to Claude as additionalContext together with the standing instruction. Exit 0 always.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { paths, loadCredentials, readJson } from '../lib/home.js';
import { buildContext } from '../lib/session-context.js';
import { inDistilRun, distilProblem, markProblemShown } from '../lib/distil.js';

try {
  await readHookInput();
  if (inDistilRun()) process.exit(0); // the background distil run needs no standing instruction
  const p = paths();
  const problem = distilProblem(p);
  const context = buildContext({ credentials: loadCredentials(p), cached: readJson(p.openQuestions), problem });
  if (context) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`);
    if (problem) markProblemShown(p, problem.error); // told once per distinct error (QA R3-5)
  }
} catch (err) {
  failOpen('session-start', err);
}
process.exitCode = 0;
