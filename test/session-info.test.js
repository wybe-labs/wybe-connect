import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectOf, cleanTitle, titleFromTranscript, claudeAccount, codexAccount, sessionInfo, TITLE_MAX } from '../lib/session-info.js';

const FIX = join(import.meta.dirname, 'fixtures');
const tmp = () => mkdtempSync(join(tmpdir(), 'wybe-connect-info-'));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ACCESS = ['eyJ', 'fakeAccessTokenValue0123456789abcdefABCDEF'].join('');
const REFRESH = ['rt_', 'fakeRefreshTokenValue0123456789abcdef'].join('');

function codexHome(payload) {
  const dir = tmp();
  const idToken = `${b64({ alg: 'none' })}.${b64(payload)}.c2lnbmF0dXJl`;
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: ACCESS, refresh_token: REFRESH, account_id: 'acct-1' } }));
  return { dir, idToken };
}

test('project is the last path segment only, for POSIX and Windows paths, never a full path', () => {
  assert.equal(projectOf('/home/eier/work/atlas-demo'), 'atlas-demo');
  assert.equal(projectOf('/home/eier/work/atlas-demo/'), 'atlas-demo');
  assert.equal(projectOf('C:\\Users\\eier\\code\\demo-app\\'), 'demo-app');
  assert.equal(projectOf('D:/src/x'), 'x');
  assert.equal(projectOf('/'), null);
  assert.equal(projectOf(''), null);
  assert.equal(projectOf(null), null);
  for (const p of ['/a/b/c', 'C:\\a\\b', 'rel/dir']) assert.ok(!/[\\/]/.test(projectOf(p)));
});

test('a title is one line, redacted and at most 80 characters', () => {
  assert.equal(cleanTitle('  Fix\nthe   retry\tqueue  '), 'Fix the retry queue');
  const long = cleanTitle('word '.repeat(60));
  assert.ok(long.length <= TITLE_MAX && long.endsWith('…'));
  const secret = cleanTitle('use DATABASE_URL=postgres://demo_user:Pl4nted-Pw@db.example.invalid/app now');
  assert.ok(!secret.includes('Pl4nted-Pw'), secret);
  assert.equal(cleanTitle('<system-reminder>x</system-reminder>  '), null);
  assert.equal(cleanTitle(''), null);
});

test('title from a Claude Code transcript: the first prompt the person typed, redacted', () => {
  const t = titleFromTranscript(join(FIX, 'session.jsonl'), 'claude-code');
  assert.ok(t && t.startsWith('Add a retry with backoff to the ingest queue'), t);
  assert.ok(!t.includes('Pl4nted-Pw'));
  assert.ok(t.length <= TITLE_MAX);
});

test('title from a Codex rollout: the person\'s own message, never AGENTS.md or the environment block', () => {
  const t = titleFromTranscript(join(FIX, 'codex-rollout.jsonl'), 'codex');
  assert.ok(t, 'a title');
  assert.ok(!/PLANTED-AGENTS-MD|PLANTED-ENV-CONTEXT|PLANTED-DEVELOPER/.test(t), t);
});

test('title: a missing or unreadable transcript is no title; a broken line is skipped', () => {
  assert.equal(titleFromTranscript(join(tmp(), 'nope.jsonl'), 'claude-code'), null);
  assert.equal(titleFromTranscript(null, 'codex'), null);
  const f = join(tmp(), 'x.jsonl');
  writeFileSync(f, '{not json\n');
  appendFileSync(f, `${JSON.stringify({ type: 'user', uuid: 'u', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'Second line prompt' } })}\n`);
  assert.equal(titleFromTranscript(f, 'claude-code'), 'Second line prompt');
});

test('Claude Code account: oauthAccount.emailAddress of <CLAUDE_CONFIG_DIR>/.claude.json; missing or broken is none', () => {
  const dir = tmp();
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'eier@example.invalid', accountUuid: 'x' }, projects: {} }));
  assert.equal(claudeAccount({ CLAUDE_CONFIG_DIR: dir }), 'eier@example.invalid');
  assert.equal(claudeAccount({ CLAUDE_CONFIG_DIR: tmp() }), null);
  const broken = tmp();
  writeFileSync(join(broken, '.claude.json'), '{');
  assert.equal(claudeAccount({ CLAUDE_CONFIG_DIR: broken }), null);
  const home = tmp();
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'hjemme@example.invalid' } }));
  assert.equal(claudeAccount({}, home), 'hjemme@example.invalid', 'without CLAUDE_CONFIG_DIR: the home directory');
});

test('Codex account: the email claim of the id_token payload in <CODEX_HOME>/auth.json, decoded only', () => {
  const { dir } = codexHome({ email: 'eier@example.invalid', sub: 'x' });
  assert.equal(codexAccount({ CODEX_HOME: dir }), 'eier@example.invalid');
  assert.equal(codexAccount({ CODEX_HOME: codexHome({ sub: 'x' }).dir }), null, 'no email claim: none');
  assert.equal(codexAccount({ CODEX_HOME: tmp() }), null, 'no auth.json: none');
  const bad = tmp();
  writeFileSync(join(bad, 'auth.json'), JSON.stringify({ tokens: { id_token: 'not-a-jwt' } }));
  assert.equal(codexAccount({ CODEX_HOME: bad }), null);
  const home = tmp();
  mkdirSync(join(home, '.codex'));
  copyFileSync(join(dir, 'auth.json'), join(home, '.codex', 'auth.json'));
  assert.equal(codexAccount({}, home), 'eier@example.invalid', 'without CODEX_HOME: ~/.codex');
});

test('sessionInfo: the report shape, and no token from auth.json anywhere in it', () => {
  const { dir, idToken } = codexHome({ email: 'eier@example.invalid' });
  const info = sessionInfo({
    harness: 'codex', sessionId: 'sess-a', cwd: '/home/eier/work/atlas-demo', transcriptPath: join(FIX, 'codex-rollout.jsonl'),
    env: { CODEX_HOME: dir }, startedAt: '2026-01-01T10:00:00.000Z', lastActiveAt: '2026-01-01T10:05:00.000Z', state: 'open',
  });
  assert.deepEqual(Object.keys(info).sort(), ['account', 'harness', 'id', 'last_active_at', 'project', 'started_at', 'state', 'title']);
  assert.equal(info.project, 'atlas-demo');
  assert.equal(info.account, 'eier@example.invalid');
  assert.equal(info.state, 'open');
  const s = JSON.stringify(info);
  for (const secret of [idToken, ACCESS, REFRESH, 'acct-1']) assert.ok(!s.includes(secret));
  const bare = sessionInfo({ harness: 'claude-code', sessionId: 'sess-b', cwd: null, transcriptPath: null, env: { CLAUDE_CONFIG_DIR: tmp() }, startedAt: '2026-01-01T10:00:00.000Z', lastActiveAt: '2026-01-01T10:00:00.000Z', state: 'closed' });
  assert.deepEqual(bare, { id: 'sess-b', harness: 'claude-code', started_at: '2026-01-01T10:00:00.000Z', last_active_at: '2026-01-01T10:00:00.000Z', state: 'closed' });
});
