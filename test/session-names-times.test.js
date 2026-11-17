// What the colleague is told about each session, as the person knows it: its own name in Claude (not the first
// thing typed in it), the time of its last line (not a file time a bulk copy or touch set), and the account only as
// the session's own process saw it (a scan never stamps other sessions with the login it runs under). Against a fake
// node on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { connectionPaths } from '../lib/connections.js';
import { saveCredentials } from '../lib/home.js';
import { touchSession, claimPoller, scanSessions, reportSession } from '../lib/bridge.js';
import { transcriptTailFacts, claudeSessionNames } from '../lib/session-info.js';
import { startFakeNode, grantFor } from './fixtures/fake-node.mjs';

const DAY = 24 * 60 * 60 * 1000;

function home(node, { account = 'first@example.invalid' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-names-'));
  const p = connectionPaths(root, 'node-a');
  saveCredentials(grantFor(node, { scopes: ['remember', 'sessions:light'] }), p);
  const claude = mkdtempSync(join(tmpdir(), 'wybe-connect-names-claude-'));
  writeFileSync(join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: account } }));
  return { root, p, claude, env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: mkdtempSync(join(tmpdir(), 'wybe-connect-names-codex-')) } };
}

/** A transcript whose lines were written `ageMs` ago; `fileAgeMs` sets the file's own time apart from that. */
function transcript(claude, { id = randomUUID(), prompt = 'Fix the flaky login test', ageMs = 0, fileAgeMs = ageMs, titles = [] } = {}) {
  const dir = join(claude, 'projects', '-work-demo');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const at = new Date(Date.now() - ageMs - 60_000).toISOString();
  const cwd = '/home/eier/work/demo';
  const lines = [
    { type: 'user', uuid: 'u-1', timestamp: at, cwd, sessionId: id, isSidechain: false, message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: 'a-1', timestamp: at, cwd, sessionId: id, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ...titles.map((customTitle) => ({ type: 'custom-title', customTitle, sessionId: id })),
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const t = new Date(Date.now() - fileAgeMs);
  utimesSync(path, t, t);
  return { id, path, at };
}

const mark = (claude, pid, sessionId, name) => {
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  writeFileSync(join(claude, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, name, nameSince: Date.now(), startedAt: Date.now() }));
};

const byId = (node) => new Map(node.tool('sessions_report').flatMap((c) => c.args.sessions).map((s) => [s.id, s]));

test('the title is the session\'s own name: the live mark\'s, else the last custom-title line; the first prompt only without one', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const marked = transcript(h.claude, { prompt: 'This session is being continued from a previous conversation', titles: ['old name'] });
    mark(h.claude, process.pid, marked.id, 'Desk: wybe');
    const renamed = transcript(h.claude, { prompt: '<artifact-content-authored-by-others/> The summarized conversation', titles: ['First name', 'PR Superbuilder'], ageMs: 2 * DAY });
    const plain = transcript(h.claude, { prompt: 'Write the import script', ageMs: 3 * DAY });
    await scanSessions(h.p, { harness: 'claude-code', env: h.env });
    const got = byId(node);
    assert.equal(got.get(marked.id).title, 'Desk: wybe');
    assert.equal(got.get(renamed.id).title, 'PR Superbuilder');
    assert.equal(got.get(plain.id).title, 'Write the import script');
  } finally {
    await node.close();
  }
});

test('a bulk copy or touch does not make old sessions recent or open: last active is the last line\'s own time', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    // written 40 days ago, but the file was touched a minute ago
    const old = transcript(h.claude, { ageMs: 40 * DAY, fileAgeMs: 60_000 });
    await scanSessions(h.p, { harness: 'claude-code', env: h.env });
    const s = byId(node).get(old.id);
    assert.equal(s.state, 'closed');
    assert.equal(s.last_active_at, old.at);
  } finally {
    await node.close();
  }
});

test('the account is the session\'s own: a scan sends none for a session it did not see, and the hooked one keeps its own login', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node, { account: 'first@example.invalid' });
    const hooked = transcript(h.claude, { prompt: 'Hooked under the first login' });
    const other = transcript(h.claude, { prompt: 'Never hooked', ageMs: DAY });
    touchSession(h.p, hooked.id, { harness: 'claude-code', cwd: '/home/eier/work/demo', transcriptPath: hooked.path });
    claimPoller(h.p, hooked.id);
    await reportSession(h.p, hooked.id, { env: h.env });
    // the scan now runs in a process signed in to the second login (same transcripts folder)
    writeFileSync(join(h.claude, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'second@example.invalid' } }));
    await scanSessions(h.p, { harness: 'claude-code', env: h.env });
    const all = node.tool('sessions_report').flatMap((c) => c.args.sessions);
    assert.ok(all.filter((s) => s.id === hooked.id).every((s) => s.account === 'first@example.invalid'), 'the hooked session keeps its own login');
    assert.ok(all.filter((s) => s.id === other.id).every((s) => s.account === undefined), 'no borrowed account');
    assert.ok(!all.some((s) => s.account === 'second@example.invalid'));
  } finally {
    await node.close();
  }
});

test('the tail reader: the last custom-title wins, the newest timestamp is the last time, a cut first line is skipped', () => {
  const lines = [
    '{"type":"user","timestamp":"2026-11-01T10:00:00.000Z"}',
    '{"type":"custom-title","customTitle":"First"}',
    '{"type":"assistant","timestamp":"2026-11-03T08:30:00.000Z"}',
    '{"type":"custom-title","customTitle":"Desk: wybe"}',
    '{"type":"last-prompt"}',
  ];
  assert.deepEqual(transcriptTailFacts(null, { text: `ype":"cut"}\n${lines.join('\n')}\n` }), { name: 'Desk: wybe', lastAt: '2026-11-03T08:30:00.000Z' });
  assert.deepEqual(transcriptTailFacts(null, { text: '' }), { name: null, lastAt: null });
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-names-big-'));
  const f = join(dir, 'big.jsonl');
  writeFileSync(f, `${'{"type":"user","timestamp":"2026-10-01T00:00:00.000Z","pad":"' + 'x'.repeat(2000) + '"}\n'}`.repeat(400));
  appendFileSync(f, '{"type":"custom-title","customTitle":"Named late"}\n');
  assert.deepEqual(transcriptTailFacts(f), { name: 'Named late', lastAt: '2026-10-01T00:00:00.000Z' });
});

test('the newest mark of a session names it', () => {
  const claude = mkdtempSync(join(tmpdir(), 'wybe-connect-names-marks-'));
  mkdirSync(join(claude, 'sessions'));
  writeFileSync(join(claude, 'sessions', '11.json'), JSON.stringify({ pid: 11, sessionId: 's-1', name: 'Old', nameSince: 1 }));
  writeFileSync(join(claude, 'sessions', '12.json'), JSON.stringify({ pid: 12, sessionId: 's-1', name: 'New', nameSince: 2 }));
  writeFileSync(join(claude, 'sessions', '13.json'), JSON.stringify({ pid: 13, sessionId: 's-2' }));
  const n = claudeSessionNames(claude);
  assert.equal(n.get('s-1'), 'New');
  assert.equal(n.has('s-2'), false);
});
