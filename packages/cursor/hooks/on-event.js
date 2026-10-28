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
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { harnessHome, loadCredentials, readJson } from '../lib/home.js';
import { connectionNames, connectionPaths, markWritten, prunePins, sessionPaths, sessionNote } from '../lib/connections.js';
import { buildContext } from '../lib/session-context.js';
import { record, flushConversation, followupFor, conversationIdOf, spoolFile } from '../lib/cursor-spool.js';

// Each record is spooled under the connection in use when it was written. A conversation moved since (or a default
// changed) leaves records under another connection: they go to that connection's node, never to this one's.
async function flushElsewhere(root, here, conversationId, event, offline) {
  if (!conversationId) return;
  for (const k of connectionNames(root)) {
    if (k === here) continue;
    const p = connectionPaths(root, k);
    if (existsSync(spoolFile(p, conversationId))) await flushConversation({ conversationId, event, offline, paths: p });
  }
}

let out = {};
let event = null;
try {
  const input = await readHookInput();
  event = typeof input.hook_event_name === 'string' ? input.hook_event_name : null;
  // every event resolves the conversation's own connection (lib/connections.js)
  const root = harnessHome('cursor');
  const sessionId = conversationIdOf(input);
  if (event === 'sessionStart') prunePins(root);
  const paths = sessionPaths(root, { sessionId });
  switch (event) {
    case 'sessionStart': {
      let context = buildContext({ credentials: loadCredentials(paths), cached: readJson(paths.openQuestions) });
      const note = sessionNote(root, paths.connection, { sessionId, command: `node "${fileURLToPath(new URL('../bin/connect.js', import.meta.url))}"` });
      context = [context, note].filter(Boolean).join('\n');
      if (context) out = { additional_context: context };
      break;
    }
    case 'beforeSubmitPrompt':
    case 'afterFileEdit':
    case 'afterAgentResponse':
    case 'postToolUse':
      // a spooled record is this conversation's writing: its pin is no longer timed (prunePins)
      if (record(input, { paths })) markWritten(root, sessionId);
      break;
    case 'stop': {
      await flushElsewhere(root, paths.connection, sessionId, event, false);
      const summary = await flushConversation({ conversationId: conversationIdOf(input), event, paths });
      process.stderr.write(queueNotice(summary));
      const followup = followupFor({ paths, status: input.status, loopCount: input.loop_count });
      if (followup) out = { followup_message: followup };
      break;
    }
    case 'sessionEnd':
      await flushElsewhere(root, paths.connection, sessionId, event, true);
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
