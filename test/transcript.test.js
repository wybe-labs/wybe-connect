import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTranscript, buildSession, readDelta, gitRemoteNames, assertLightIsClean, stripInjected } from '../lib/transcript.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'session.jsonl');
const text = readFileSync(FIXTURE, 'utf8');

const PLANTED = {
  assistant: 'PLANTED-ASSISTANT-SENTENCE',
  thinking: 'PLANTED-THINKING-SENTENCE',
  toolOutput: 'PLANTED-TOOL-OUTPUT',
  reminder: 'PLANTED-REMINDER',
  sidechain: 'PLANTED-SIDECHAIN-PROMPT',
  meta: 'PLANTED-META-ENTRY',
};

function parsed() {
  return parseTranscript(text, { strict: true }).entries;
}

test('the fixture parses strictly: every line type is known, nothing is partial', () => {
  const r = parseTranscript(text, { strict: true });
  assert.deepEqual(r.unknownTypes, {});
  assert.equal(r.partialTail, '');
  const kinds = r.entries.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
  assert.deepEqual(kinds, { other: 3, prompt: 4, thinking: 1, 'assistant-text': 3, 'tool-use': 3, 'tool-result': 3 });
});

test('strict parsing throws on an unknown line type; lenient counts it', () => {
  const extra = `${text}{"type":"future-bookkeeping","x":1}\n`;
  assert.throws(() => parseTranscript(extra, { strict: true }), /unknown line type "future-bookkeeping"/);
  const r = parseTranscript(extra);
  assert.deepEqual(r.unknownTypes, { 'future-bookkeeping': 1 });
});

test('a malformed line in the middle throws; a malformed LAST line is a partial tail', () => {
  assert.throws(() => parseTranscript('{"type":"user","message":{"role":"user","content":"a"}}\n{not json\n{"type":"last-prompt"}\n', { strict: true }), /malformed JSON on line 2/);
  const r = parseTranscript('{"type":"last-prompt"}\n{"type":"user","mes');
  assert.equal(r.partialTail, '{"type":"user","mes');
  assert.equal(r.entries.length, 1);
});

test('an unknown content block type throws rather than being skipped', () => {
  const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'hologram', data: 1 }] } });
  assert.throws(() => parseTranscript(`${line}\n`), /unknown assistant block type "hologram"/);
});

test('LIGHT: project, branch, files touched, duration and the person\'s own prompts', () => {
  const s = buildSession(parsed(), { scope: 'sessions:light', transcriptId: 't-1', gitRemotes: ['origin'] });
  assert.deepEqual(Object.keys(s), ['scope', 'harness', 'session_id', 'transcript_id', 'project', 'started_at', 'ended_at', 'duration_s', 'files_touched', 'prompts', 'counts']);
  assert.equal(s.scope, 'sessions:light');
  assert.equal(s.harness, 'claude-code');
  assert.equal(s.session_id, '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(s.project, { name: 'atlas-demo', git_remotes: ['origin'], branch: 'feat/retry' });
  assert.equal(s.started_at, '2026-09-22T09:00:00.000Z');
  assert.equal(s.ended_at, '2026-09-22T09:03:20.000Z');
  assert.equal(s.duration_s, 200);
  assert.deepEqual(s.files_touched, ['/home/kari/work/atlas-demo/lib/queue.js', '/home/kari/work/atlas-demo/test/queue.test.js']);
  assert.equal(s.prompts.length, 2);
  assert.match(s.prompts[0].text, /^Add a retry with backoff/);
  assert.equal(s.prompts[1].text, 'Also cap the retries at five.');
  assert.deepEqual(s.counts, { prompts: 2, assistant_turns: 3, tool_calls: 3 });
});

test('LIGHT carries zero assistant text, no thinking, no tool I/O, no sidechain, no meta, no injected reminders', () => {
  const s = JSON.stringify(buildSession(parsed(), { scope: 'sessions:light' }));
  for (const [what, needle] of Object.entries(PLANTED)) {
    assert.ok(!s.includes(needle), `${what} leaked into the light payload`);
  }
});

test('POSITIVE CONTROL: FULL carries the planted assistant sentence and tool output, but never thinking, sidechain or meta', () => {
  const full = buildSession(parsed(), { scope: 'sessions:full' });
  const s = JSON.stringify(full);
  assert.ok(s.includes(PLANTED.assistant), 'the planted sentence must be present under sessions:full, or the light test proves nothing');
  assert.ok(s.includes(PLANTED.toolOutput));
  assert.ok(!s.includes(PLANTED.thinking), 'thinking never leaves the machine');
  assert.ok(!s.includes(PLANTED.sidechain));
  assert.ok(!s.includes(PLANTED.meta));
  assert.ok(!s.includes(PLANTED.reminder));
  assert.deepEqual(full.turns.map((t) => t.role), ['user', 'assistant', 'tool', 'tool', 'tool', 'assistant', 'user', 'assistant']);
  assert.equal(full.turns[2].tool.name, 'Read');
  assert.equal(full.turns[2].tool.output, 'export function worker() { /* PLANTED-TOOL-OUTPUT */ }');
  assert.equal(full.turns[3].tool.output, 'The file has been updated.');
});

test('FULL clips oversized tool I/O to the configured budget', () => {
  const full = buildSession(parsed(), { scope: 'sessions:full', maxToolChars: 20 });
  const read = full.turns[2].tool;
  assert.ok(read.input.length < 60 && read.input.includes('[+'), read.input);
  assert.ok(read.output.startsWith('export function work') && read.output.includes('chars]'));
});

test('THE TRAP fires: a light payload that was handed assistant text is refused', () => {
  const entries = parsed();
  const s = buildSession(entries, { scope: 'sessions:light' });
  const corrupted = { ...s, prompts: [...s.prompts, { at: null, text: 'PLANTED-ASSISTANT-SENTENCE: I will add exponential backoff' }] };
  assert.throws(() => assertLightIsClean(corrupted, entries), /light payload carried assistant-text content/);
  assert.throws(() => assertLightIsClean({ ...s, turns: [] }, entries), /carried turns/);
  assert.doesNotThrow(() => assertLightIsClean(s, entries));
});

test('an unknown scope is refused', () => {
  assert.throws(() => buildSession(parsed(), { scope: 'sessions:everything' }), /unknown scope/);
});

test('stripInjected removes hook-injected system reminders and trims', () => {
  assert.equal(stripInjected('hello <system-reminder>\nnot mine\n</system-reminder> world'), 'hello  world');
  assert.equal(stripInjected('<system-reminder>only</system-reminder>'), '');
});

test('readDelta advances by bytes, leaves a partial line, and restarts when the file shrank', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-delta-'));
  const p = join(dir, 't.jsonl');
  writeFileSync(p, '{"type":"last-prompt"}\n{"type":"mode","m');
  const a = readDelta(p, 0);
  assert.equal(a.text, '{"type":"last-prompt"}\n');
  assert.equal(a.nextOffset, 23);
  assert.equal(a.restarted, false);
  appendFileSync(p, 'ode":"x"}\n');
  const b = readDelta(p, a.nextOffset);
  assert.equal(b.text, '{"type":"mode","mode":"x"}\n');
  assert.equal(b.nextOffset, 23 + 27);
  const c = readDelta(p, b.nextOffset);
  assert.equal(c.text, '');
  assert.equal(c.nextOffset, b.nextOffset);
  writeFileSync(p, '{"type":"pr-link"}\n');
  const d = readDelta(p, b.nextOffset);
  assert.equal(d.restarted, true);
  assert.equal(d.text, '{"type":"pr-link"}\n');
  assert.equal(d.nextOffset, 19);
});

test('gitRemoteNames returns names only, never the URL or its userinfo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-git-'));
  mkdirSync(join(dir, '.git'));
  const pw = ['s3', 'cret-pw'].join('');
  writeFileSync(join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://deploy:${pw}@github.com/wybe-labs/x.git\n[remote "vps"]\n\turl = ssh://git@1.2.3.4/srv/x\n[branch "main"]\n\tremote = origin\n`);
  const names = gitRemoteNames(dir);
  assert.deepEqual(names, ['origin', 'vps']);
  assert.ok(!JSON.stringify(names).includes(pw));
  assert.deepEqual(gitRemoteNames(join(dir, 'nope')), []);
});

test('gitRemoteNames follows a worktree .git file to the common config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-wt-'));
  const main = join(dir, 'main');
  const wt = join(dir, 'wt');
  mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  mkdirSync(wt);
  writeFileSync(join(main, '.git', 'config'), '[remote "upstream"]\n\turl = https://example.com/x.git\n');
  writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.deepEqual(gitRemoteNames(wt), ['upstream']);
});
