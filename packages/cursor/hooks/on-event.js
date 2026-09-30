#!/usr/bin/env node
// Every Cursor hook of wybe-connect runs this one script; it dispatches on `hook_event_name`
// (payloads and outputs: https://cursor.com/docs/agent/hooks, read 2026-09-29).
//   sessionStart        -> { additional_context: standing line + cached open questions }
//   beforeSubmitPrompt  -> spool the prompt; always { continue: true } (never blocks a prompt)
//   afterFileEdit, afterAgentResponse, postToolUse -> spool (scope-checked); {}
//   stop                -> flush the spool; { followup_message } only when lib/cursor-spool.js
//                          followupFor() allows it, else {}
//   sessionEnd          -> flush the spool into the local queue, no network
// Exit 0 always, one JSON object on stdout, at most one line on stderr, never a secret.

import { readHookInput, failOpen, queueNotice } from '../lib/hook-io.js';
import { paths as pathsOf, harnessHome, loadCredentials, readJson } from '../lib/home.js';
import { buildContext } from '../lib/session-context.js';
import { record, flushConversation, followupFor, conversationIdOf } from '../lib/cursor-spool.js';

let out = {};
let event = null;
try {
  const input = await readHookInput();
  event = typeof input.hook_event_name === 'string' ? input.hook_event_name : null;
  const paths = pathsOf(harnessHome('cursor'));
  switch (event) {
    case 'sessionStart': {
      const context = buildContext({ credentials: loadCredentials(paths), cached: readJson(paths.openQuestions) });
      if (context) out = { additional_context: context };
      break;
    }
    case 'beforeSubmitPrompt':
    case 'afterFileEdit':
    case 'afterAgentResponse':
    case 'postToolUse':
      record(input, { paths });
      break;
    case 'stop': {
      const summary = await flushConversation({ conversationId: conversationIdOf(input), event, paths });
      process.stderr.write(queueNotice(summary));
      const followup = followupFor({ paths, status: input.status, loopCount: input.loop_count });
      if (followup) out = { followup_message: followup };
      break;
    }
    case 'sessionEnd':
      await flushConversation({ conversationId: conversationIdOf(input), event, offline: true, paths });
      break;
    default:
      break;
  }
} catch (err) {
  failOpen(event ?? 'hook', err);
}
if (event === 'beforeSubmitPrompt') out = { continue: true };
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exitCode = 0;
