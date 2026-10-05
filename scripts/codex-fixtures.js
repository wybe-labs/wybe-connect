// Writes the synthetic Codex rollout fixtures under test/fixtures/. Run: node scripts/codex-fixtures.js
//
// The SHAPE is the one verified for lib/codex-rollout.js (openai/codex @ 0462dcc0 source, plus a
// key-and-type census of 24 real rollouts from Codex 0.153.4-0.155.0-alpha.9.2). The CONTENT is
// invented. PLANTED-* markers are bait: each names something that must never reach a payload of
// the wrong scope. The DSN in the first prompt is planted for the redactor.
// Kept as a script (not under test/) because node --test would run anything under test/.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'test', 'fixtures');
const SID = '0190c0de-0000-7000-8000-00000000c0de';
const CWD = '/home/kari/work/atlas-demo';
const T = (s) => `2026-09-22T09:${s}.000Z`;
let ord = 0;
const L = (timestamp, type, payload) => JSON.stringify({ timestamp, ordinal: ord++, type, payload });

const meta = (historyMode, source) => L(T('00:00'), 'session_meta', {
  session_id: SID, id: SID, timestamp: T('00:00'), cwd: CWD, originator: 'codex_cli_rs', cli_version: '0.155.0',
  source, thread_source: 'user', model_provider: 'openai', history_mode: historyMode,
  context_window: { window_id: 'w-1' },
  git: { commit_hash: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', branch: 'feat/retry', repository_url: 'https://deploy:PLANTED-REMOTE-PW@github.com/kari/atlas-demo.git' },
});
const turnCtx = (s, turn) => L(T(s), 'turn_context', {
  turn_id: turn, root_turn_id: turn, cwd: CWD, workspace_roots: [CWD], current_date: '2026-09-22', timezone: 'Europe/Oslo',
  approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write', writable_roots: [CWD], network_access: false },
  model: 'gpt-5.5-codex', effort: 'medium', summary: 'auto',
});
const msg = (s, role, type, text, extra = {}) => L(T(s), 'response_item', { type: 'message', id: `msg_${ord}`, role, content: [{ type, text }], ...extra });
const userItem = (s, turn, text) => L(T(s), 'event_msg', {
  type: 'item_completed', thread_id: SID, turn_id: turn,
  item: { type: 'UserMessage', id: `item_${ord}`, client_id: 'c-1', content: [{ type: 'text', text, text_elements: [] }] },
  started_at_ms: 1, completed_at_ms: 2,
});
const PROMPT = 'Add a retry with backoff to the ingest queue, and use DATABASE_URL=postgres://demo_user:Pl4nted-Pw@db.example.internal:5432/demo for the smoke test';

function paginated() {
  ord = 0;
  return [
    meta('paginated', 'cli'),
    turnCtx('00:01', 'turn-1'),
    msg('00:01', 'developer', 'input_text', '<permissions instructions>PLANTED-DEVELOPER sandbox is workspace-write</permissions instructions>'),
    msg('00:01', 'user', 'input_text', `# AGENTS.md instructions for ${CWD}\n\n<INSTRUCTIONS>\nPLANTED-AGENTS-MD always run bun test\n</INSTRUCTIONS>`),
    msg('00:01', 'user', 'input_text', `<environment_context>\n  <cwd>${CWD}</cwd>\n  <shell>bash</shell>\n  PLANTED-ENV-CONTEXT\n</environment_context>`),
    L(T('00:02'), 'event_msg', { type: 'task_started', turn_id: 'turn-1', started_at: 1, model_context_window: 272000, collaboration_mode_kind: 'default', root_turn_id: 'turn-1' }),
    msg('00:02', 'user', 'input_text', PROMPT),
    userItem('00:02', 'turn-1', PROMPT),
    L(T('00:04'), 'response_item', { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'PLANTED-THINKING-SENTENCE the person wants exponential backoff' }], content: null, encrypted_content: 'gAAAAABoPLANTEDENCRYPTED' }),
    msg('00:05', 'assistant', 'output_text', 'PLANTED-ASSISTANT-SENTENCE: I will add exponential backoff to the queue worker.', { phase: 'commentary' }),
    L(T('00:06'), 'response_item', { type: 'function_call', id: 'fc_1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'sed -n 1,80p lib/queue.js', workdir: CWD }), call_id: 'call_01' }),
    L(T('00:06'), 'response_item', { type: 'function_call_output', id: 'fco_1', call_id: 'call_01', output: 'export function worker() { /* PLANTED-TOOL-OUTPUT */ }' }),
    L(T('00:09'), 'response_item', { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'call_02', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: lib/queue.js\n@@\n-export function worker() {}\n+export function worker({ retries = 5 } = {}) {}\n*** Add File: test/queue.test.js\n+import { test } from "node:test";\n*** End Patch\n' }),
    L(T('00:09'), 'response_item', { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_02', output: 'Success. Updated the following files:\nM lib/queue.js\nA test/queue.test.js\n' }),
    L(T('00:09'), 'event_msg', {
      type: 'item_completed', thread_id: SID, turn_id: 'turn-1',
      item: { type: 'FileChange', id: 'fc-item-1', changes: { [`${CWD}/lib/queue.js`]: { type: 'update', unified_diff: '@@ -1 +1 @@', move_path: null }, [`${CWD}/test/queue.test.js`]: { type: 'add', content: 'import { test } from "node:test";' } }, status: 'completed' },
      started_at_ms: 3, completed_at_ms: 4,
    }),
    L(T('00:10'), 'response_item', { type: 'agent_message', id: 'am_1', author: '/root/reviewer', recipient: '/root', content: [{ type: 'input_text', text: 'PLANTED-INTER-AGENT the reviewer says the patch is fine' }] }),
    msg('00:12', 'assistant', 'output_text', 'Added exponential backoff with a retry cap; the smoke test uses the DSN you gave.', { phase: 'final_answer' }),
    L(T('00:12'), 'event_msg', { type: 'token_count', info: null, rate_limits: null }),
    L(T('00:12'), 'event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Added exponential backoff with a retry cap; the smoke test uses the DSN you gave.', started_at: 1, completed_at: 2, duration_ms: 10000 }),
    L(T('00:12'), 'token_usage_record', { thread_id: SID, turn_id: 'turn-1', usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 } }),
    L(T('00:12'), 'world_state', { full: true, state: { agents_md: {} } }),
    turnCtx('02:00', 'turn-2'),
    msg('02:00', 'user', 'input_text', 'Also cap the retries at five.'),
    userItem('02:00', 'turn-2', 'Also cap the retries at five.'),
    L(T('02:30'), 'compacted', { message: '', replacement_history: [{ type: 'message', id: 'r1', role: 'user', content: [{ type: 'input_text', text: 'PLANTED-COMPACTED-HISTORY an older prompt replayed by compaction' }] }], window_number: 2, first_window_id: 'w-1', previous_window_id: 'w-1', window_id: 'w-2' }),
    L(T('02:30'), 'response_item', { type: 'compaction', id: 'cmp_1', encrypted_content: 'gAAAAABoPLANTEDCOMPACTION' }),
    msg('03:20', 'assistant', 'output_text', 'Capped at five retries.', { phase: 'final_answer' }),
    L(T('03:20'), 'event_msg', { type: 'task_complete', turn_id: 'turn-2', last_agent_message: 'Capped at five retries.', started_at: 3, completed_at: 4, duration_ms: 80000 }),
  ].join('\n') + '\n';
}

function legacy() {
  ord = 0;
  return [
    meta('legacy', 'cli'),
    turnCtx('00:01', 'turn-1'),
    msg('00:01', 'user', 'input_text', `<environment_context>\n  <cwd>${CWD}</cwd>\n  PLANTED-ENV-CONTEXT\n</environment_context>`),
    msg('00:02', 'user', 'input_text', 'Rename the worker to drainQueue.'),
    L(T('00:02'), 'event_msg', { type: 'user_message', message: 'Rename the worker to drainQueue.', images: [], local_images: [], text_elements: [] }),
    msg('00:05', 'assistant', 'output_text', 'PLANTED-ASSISTANT-SENTENCE renaming now.', { phase: 'commentary' }),
    L(T('00:05'), 'event_msg', { type: 'agent_message', message: 'PLANTED-ASSISTANT-SENTENCE renaming now.', phase: 'commentary' }),
    L(T('00:06'), 'response_item', { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'call_01', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: lib/queue.js\n*** Move to: lib/drain.js\n@@\n-worker\n+drainQueue\n*** End Patch\n' }),
    L(T('00:06'), 'event_msg', { type: 'patch_apply_end', call_id: 'call_01', turn_id: 'turn-1', stdout: 'M lib/drain.js', stderr: '', success: true, changes: { [`${CWD}/lib/queue.js`]: { update: { unified_diff: '', move_path: `${CWD}/lib/drain.js` } } } }),
    L(T('00:06'), 'response_item', { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_01', output: 'Success.' }),
    msg('00:08', 'assistant', 'output_text', 'Renamed.', { phase: 'final_answer' }),
    L(T('00:08'), 'event_msg', { type: 'agent_message', message: 'Renamed.', phase: 'final_answer' }),
  ].join('\n') + '\n';
}

function subagent() {
  ord = 0;
  return [
    meta('paginated', { subagent: { thread_spawn: { parent_thread_id: SID, depth: 1, agent_path: '/root/reviewer', agent_nickname: 'reviewer', agent_role: null } } }),
    msg('00:01', 'user', 'input_text', 'PLANTED-SIDECHAIN-PROMPT review the patch in lib/queue.js'),
    userItem('00:01', 'turn-1', 'PLANTED-SIDECHAIN-PROMPT review the patch in lib/queue.js'),
    msg('00:03', 'assistant', 'output_text', 'The patch is fine.', { phase: 'final_answer' }),
  ].join('\n') + '\n';
}

// UserMessage texts the Codex desktop app and IDE extension wrap around the person's words, in the
// shapes the census found (tag names and template headers only; the content is invented).
function injected() {
  ord = 0;
  return [
    meta('paginated', 'vscode'),
    userItem('00:01', 'turn-1', '<in-app-browser-context>\n<url>http://localhost:3000/PLANTED-BROWSER-CONTEXT</url>\n</in-app-browser-context>\nWhat does this page do?'),
    userItem('00:02', 'turn-2', '<heartbeat>\nPLANTED-HEARTBEAT automation tick\n</heartbeat>'),
    userItem('00:03', 'turn-3', '<send_user_message_question_reply>\n<question>PLANTED-QUESTION-BY-ASSISTANT which branch?</question>\n<answer>main</answer>\n</send_user_message_question_reply>'),
    userItem('00:04', 'turn-4', '# Files mentioned by the user:\n\n## PLANTED-ATTACHMENT-NAME.pdf: /home/kari/Documents/PLANTED-ATTACHMENT-NAME.pdf\n\n## My request for Codex:\nSummarise the notice period in the attached file.'),
    userItem('00:05', 'turn-5', '# Context from my IDE setup:\n\n## Active file: PLANTED-IDE-CONTEXT.ts\n'),
    userItem('00:05', 'turn-5b', '<in-app-browser-context>\n<selection>PLANTED-BROWSER-CONTEXT</selection>\n</in-app-browser-context>\n\n## My request:\nExplain this selection.'),
    userItem('00:06', 'turn-6', '# A heading the person typed\nand a second line'),
  ].join('\n') + '\n';
}

writeFileSync(join(OUT, 'codex-rollout.jsonl'), paginated());
writeFileSync(join(OUT, 'codex-rollout-injected.jsonl'), injected());
writeFileSync(join(OUT, 'codex-rollout-legacy.jsonl'), legacy());
writeFileSync(join(OUT, 'codex-rollout-subagent.jsonl'), subagent());
process.stdout.write('codex-fixtures: 4 files written to test/fixtures\n');
