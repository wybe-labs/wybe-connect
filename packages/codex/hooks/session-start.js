#!/usr/bin/env node
// Codex SessionStart hook. A hook has no MCP client, so it cannot call pending_questions itself;
// it reads the open questions the last tool response carried (lib/flush.js stores them) and hands
// them to the model with the standing instruction, in the output shape of
// codex-rs/hooks/schema/generated/session-start.command.output.schema.json. Exit 0 always.

import { readHookInput, failOpen } from '../lib/hook-io.js';
import { paths, harnessHome, loadCredentials, readJson } from '../lib/home.js';
import { buildContext } from '../lib/session-context.js';

try {
  await readHookInput();
  const p = paths(harnessHome('codex'));
  const context = buildContext({ credentials: loadCredentials(p), cached: readJson(p.openQuestions) });
  if (context) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`);
  }
} catch (err) {
  failOpen('session-start', err);
}
process.exitCode = 0;
