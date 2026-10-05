import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRollout, rolloutHead, headOf, patchPaths, stripCodexInjected } from '../lib/codex-rollout.js';
import { buildSession, assertLightIsClean } from '../lib/transcript.js';

// Fixtures are synthetic, written by scripts/codex-fixtures.js in the shape verified against the
// Codex source and a census of real rollouts (see the header of lib/codex-rollout.js).
const FIX = join(import.meta.dirname, 'fixtures');
const PAGINATED = join(FIX, 'codex-rollout.jsonl');
const LEGACY = join(FIX, 'codex-rollout-legacy.jsonl');
const SUBAGENT = join(FIX, 'codex-rollout-subagent.jsonl');
const SID = '0190c0de-0000-7000-8000-00000000c0de';
const CWD = '/home/kari/work/atlas-demo';

const PLANTED = {
  assistant: 'PLANTED-ASSISTANT-SENTENCE',
  thinking: 'PLANTED-THINKING-SENTENCE',
  toolOutput: 'PLANTED-TOOL-OUTPUT',
  developer: 'PLANTED-DEVELOPER',
  agentsMd: 'PLANTED-AGENTS-MD',
  envContext: 'PLANTED-ENV-CONTEXT',
  interAgent: 'PLANTED-INTER-AGENT',
  compacted: 'PLANTED-COMPACTED-HISTORY',
  remotePassword: 'PLANTED-REMOTE-PW',
  encrypted: 'PLANTEDENCRYPTED',
  sidechain: 'PLANTED-SIDECHAIN-PROMPT',
};
// What a full payload may carry that a light one may not (the positive control's list).
const FULL_ONLY = new Set(['assistant', 'toolOutput']);

function load(path) {
  const text = readFileSync(path, 'utf8');
  return parseRollout(text, { strict: true, head: rolloutHead(path) });
}

test('codex: the paginated fixture parses strictly; every line and response_item type is known', () => {
  const r = load(PAGINATED);
  assert.deepEqual(r.unknownTypes, {});
  assert.equal(r.partialTail, '');
  const kinds = r.entries.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
  assert.deepEqual(kinds, { other: 15, context: 2, prompt: 2, thinking: 1, 'assistant-text': 3, 'tool-use': 2, 'tool-result': 2, 'file-change': 4 });
});

test('codex: rolloutHead reads session id, cwd and branch from session_meta, and never the remote URL', () => {
  const h = rolloutHead(PAGINATED);
  assert.deepEqual(h, { sessionId: SID, cwd: CWD, branch: 'feat/retry', cliVersion: '0.155.0', historyMode: 'paginated', personThread: true });
  assert.ok(!JSON.stringify(h).includes(PLANTED.remotePassword));
});

test('codex: a subagent or internal source is not the person\'s thread; a custom source is', () => {
  assert.equal(rolloutHead(SUBAGENT).personThread, false);
  const meta = (source) => headOf({ type: 'session_meta', payload: { id: 'x', cwd: '/w', source } });
  assert.equal(meta('cli').personThread, true);
  assert.equal(meta('exec').personThread, true);
  assert.equal(meta({ internal: 'memory_consolidation' }).personThread, false);
  assert.equal(meta({ subagent: { other: 'x' } }).personThread, false);
  assert.equal(meta({ custom: 'my-ide' }).personThread, true);
  assert.equal(headOf({ type: 'response_item', payload: {} }), null);
});

test('codex LIGHT: the same key set as Claude Code, the person\'s own prompts from event_msg, files from FileChange + apply_patch', () => {
  const s = buildSession(load(PAGINATED).entries, { scope: 'sessions:light', harness: 'codex', transcriptId: 't-1', gitRemotes: ['origin'] });
  assert.deepEqual(Object.keys(s), ['scope', 'harness', 'session_id', 'transcript_id', 'project', 'started_at', 'ended_at', 'duration_s', 'files_touched', 'prompts', 'counts']);
  assert.equal(s.harness, 'codex');
  assert.equal(s.session_id, SID);
  assert.deepEqual(s.project, { name: 'atlas-demo', git_remotes: ['origin'], branch: 'feat/retry' });
  assert.equal(s.started_at, '2026-09-22T09:00:00.000Z');
  assert.equal(s.ended_at, '2026-09-22T09:03:20.000Z');
  assert.equal(s.duration_s, 200);
  assert.deepEqual(s.files_touched, [`${CWD}/lib/queue.js`, `${CWD}/test/queue.test.js`]);
  assert.deepEqual(s.prompts.map((p) => p.text), [
    'Add a retry with backoff to the ingest queue, and use DATABASE_URL=postgres://demo_user:Pl4nted-Pw@db.example.internal:5432/demo for the smoke test',
    'Also cap the retries at five.',
  ]);
  assert.deepEqual(s.counts, { prompts: 2, assistant_turns: 3, tool_calls: 2 });
});

test('codex LIGHT carries none of the bait: no assistant text, thinking, tool I/O, injected context, inter-agent, compaction replay, remote URL', () => {
  const s = JSON.stringify(buildSession(load(PAGINATED).entries, { scope: 'sessions:light', harness: 'codex' }));
  for (const [what, needle] of Object.entries(PLANTED)) assert.ok(!s.includes(needle), `${what} leaked into the codex light payload`);
});

test('codex POSITIVE CONTROL: FULL carries the planted assistant sentence and tool output, and still none of the rest', () => {
  const full = buildSession(load(PAGINATED).entries, { scope: 'sessions:full', harness: 'codex' });
  const s = JSON.stringify(full);
  for (const [what, needle] of Object.entries(PLANTED)) {
    if (FULL_ONLY.has(what)) assert.ok(s.includes(needle), `${what} must be present under sessions:full, or the light test proves nothing`);
    else assert.ok(!s.includes(needle), `${what} leaked into the codex full payload`);
  }
  assert.deepEqual(full.turns.map((t) => t.role), ['user', 'assistant', 'tool', 'tool', 'assistant', 'user', 'assistant']);
  assert.equal(full.turns[2].tool.name, 'exec_command');
  assert.equal(full.turns[2].tool.output, 'export function worker() { /* PLANTED-TOOL-OUTPUT */ }');
  assert.match(full.turns[2].tool.input, /sed -n 1,80p lib\/queue\.js/);
  assert.equal(full.turns[3].tool.name, 'apply_patch');
});

test('codex THE TRAP fires on a light payload that was handed assistant text or injected developer context', () => {
  const entries = load(PAGINATED).entries;
  const s = buildSession(entries, { scope: 'sessions:light', harness: 'codex' });
  assert.throws(() => assertLightIsClean({ ...s, prompts: [...s.prompts, { at: null, text: 'PLANTED-ASSISTANT-SENTENCE: I will add' }] }, entries), /assistant-text/);
  assert.throws(() => assertLightIsClean({ ...s, prompts: [...s.prompts, { at: null, text: '<permissions instructions>PLANTED-DEVELOPER' }] }, entries), /context/);
  assert.doesNotThrow(() => assertLightIsClean(s, entries));
});

test('codex legacy history mode: prompts from user_message, files from patch_apply_end and the apply_patch move, no double-counted replies', () => {
  const s = buildSession(load(LEGACY).entries, { scope: 'sessions:light', harness: 'codex' });
  assert.deepEqual(s.prompts.map((p) => p.text), ['Rename the worker to drainQueue.']);
  assert.deepEqual(s.files_touched, [`${CWD}/lib/drain.js`, `${CWD}/lib/queue.js`]);
  assert.deepEqual(s.counts, { prompts: 1, assistant_turns: 2, tool_calls: 1 });
  const text = JSON.stringify(s);
  assert.ok(!text.includes(PLANTED.assistant) && !text.includes(PLANTED.envContext));
});

test('codex subagent rollout: everything is a sidechain, so nothing of it reaches either payload', () => {
  const entries = load(SUBAGENT).entries;
  assert.ok(entries.length > 0 && entries.every((e) => e.sidechain));
  for (const scope of ['sessions:light', 'sessions:full']) {
    const s = buildSession(entries, { scope, harness: 'codex' });
    assert.deepEqual(s.prompts, []);
    assert.ok(!JSON.stringify(s).includes(PLANTED.sidechain), `${scope} carried a subagent prompt`);
  }
});

test('codex: a delta that starts mid-file takes session id and branch from the head', () => {
  const lines = readFileSync(PAGINATED, 'utf8').split('\n');
  const tail = `${lines.slice(21).join('\n')}`;
  const r = parseRollout(tail, { strict: true, head: rolloutHead(PAGINATED) });
  const s = buildSession(r.entries, { scope: 'sessions:light', harness: 'codex' });
  assert.equal(s.session_id, SID);
  assert.equal(s.project.branch, 'feat/retry');
  assert.deepEqual(s.prompts.map((p) => p.text), ['Also cap the retries at five.']);
});

test('codex: an unknown response_item type throws strict and is counted lenient; a partial last line is left', () => {
  const line = JSON.stringify({ timestamp: 'x', type: 'response_item', payload: { type: 'hologram' } });
  assert.throws(() => parseRollout(`${line}\n`, { strict: true }), /unknown response_item type "hologram"/);
  assert.deepEqual(parseRollout(`${line}\n`).unknownTypes, { 'response_item/hologram': 1 });
  assert.throws(() => parseRollout('{"type":"future_item"}\n', { strict: true }), /unknown line type "future_item"/);
  const r = parseRollout('{"type":"world_state","payload":{}}\n{"type":"event_ms');
  assert.equal(r.partialTail, '{"type":"event_ms');
});

test('patchPaths reads every Add/Update/Delete target and Move destination of an apply_patch body', () => {
  assert.deepEqual(patchPaths('*** Begin Patch\n*** Add File: a.js\n+x\n*** Delete File: b.js\n*** Update File: c.js\n*** Move to: d/c.js\n@@\n*** End Patch'), ['a.js', 'b.js', 'c.js', 'd/c.js']);
  assert.deepEqual(patchPaths('no patch here'), []);
});

test('codex: text the desktop app / IDE extension wrapped around a prompt is stripped; automation and assistant-authored turns are dropped', () => {
  const path = join(FIX, 'codex-rollout-injected.jsonl');
  const s = buildSession(load(path).entries, { scope: 'sessions:light', harness: 'codex' });
  assert.deepEqual(s.prompts.map((p) => p.text), [
    'What does this page do?',
    'Summarise the notice period in the attached file.',
    'Explain this selection.',
    '# A heading the person typed\nand a second line',
  ]);
  const text = JSON.stringify(s);
  for (const needle of ['PLANTED-BROWSER-CONTEXT', 'PLANTED-HEARTBEAT', 'PLANTED-QUESTION-BY-ASSISTANT', 'PLANTED-ATTACHMENT-NAME', 'PLANTED-IDE-CONTEXT', 'My request for Codex']) {
    assert.ok(!text.includes(needle), `${needle} leaked into the prompts`);
  }
});

test('stripCodexInjected: leading tag blocks go, the IDE template keeps only the request, a lone template is dropped', () => {
  assert.equal(stripCodexInjected('<a x="1">one</a>\n<b>two</b>\nmine'), 'mine');
  assert.equal(stripCodexInjected('mine <a>inline</a> stays'), 'mine <a>inline</a> stays');
  assert.equal(stripCodexInjected('# Context from my IDE setup:\n\n## Open tabs:\n- x.ts\n\n## My request for Codex:\nfix it'), 'fix it');
  assert.equal(stripCodexInjected('<ctx>x</ctx>\n## My request for Codex:\nfix that'), 'fix that');
  assert.equal(stripCodexInjected('# Files mentioned by the user:\n\n## x.pdf: /x.pdf\n'), '');
  assert.equal(stripCodexInjected('<unclosed>tag and text'), '<unclosed>tag and text');
});
