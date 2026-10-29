// A pin lives as long as its session can still be resumed. A Codex rollout is not gone when it is compressed in place
// (rollout-X.jsonl -> rollout-X.jsonl.zst), materialised back to .jsonl on resume, or moved into archived_sessions:
// the session keeps its pin through every SessionStart (each one prunes), so a session moved to B stays on B and one
// pinned to none never falls to the default. Only a rollout gone under every spelling and every Codex directory
// lets its pin go. These rows run the real Codex SessionStart hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinnedConnection, recordTranscript, removeConnection, saveConnection, sessionConnection, sessionLines, sessionPaths, useConnection } from '../lib/connections.js';
import * as R from '../lib/codex-rollout.js';
import { runConnect } from '../lib/connect-cli.js';

const ROOT = join(import.meta.dirname, '..');
const HOOK = join(ROOT, 'packages', 'codex', 'hooks', 'session-start.js');
const FIX = readFileSync(join(import.meta.dirname, 'fixtures', 'codex-rollout.jsonl'), 'utf8');
const SID = '0190c0de-0000-7000-8000-0000000012aa';
const OTHER = '0190c0de-0000-7000-8000-0000000012bb';
const N = (c) => `https://node-${c}.example.invalid`;
const H = (c) => `node-${c}.example.invalid`;
const tok = (c) => ['wat_', c.repeat(40)].join('');
const grant = (c) => ({ version: 1, nodeUrl: N(c), resource: `${N(c)}/mcp`, mcpEndpoint: `${N(c)}/mcp`, issuer: 'https://auth.example.invalid', tokenEndpoint: 'https://auth.example.invalid/token', clientId: 'wybe-connect-codex', accessToken: tok(c), refreshToken: null, expiresAt: null, scopes: ['remember', 'sessions:full'] });
const rolloutName = (sid) => `rollout-2026-01-02T09-00-00-${sid}.jsonl`;

function sessionStart(s, sessionId, transcriptPath) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, WYBE_CONNECT_HOME: s.home, CODEX_HOME: s.codexHome };
    delete env.WYBE_CONNECT_NODE;
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, cwd: s.dir, hook_event_name: 'SessionStart', source: 'resume', model: 'm' }));
  });
}

// A is the default, B also connected; a Codex session with a rollout starts on A and is moved to B, which then gets
// two more lines. With removeB, B is removed afterwards: the session is pinned to none.
async function setup({ removeB = false, move = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-zst-'));
  const s = { dir, home: join(dir, 'home'), codexHome: join(dir, 'codex-home') };
  s.root = join(s.home, 'codex');
  saveConnection(s.root, grant('b'));
  saveConnection(s.root, grant('a'));
  useConnection(s.root, H('a'));
  const day = join(s.codexHome, 'sessions', '2026', '01', '02');
  mkdirSync(day, { recursive: true });
  s.rollout = join(day, rolloutName(SID));
  writeFileSync(s.rollout, FIX);
  const r = await sessionStart(s, SID, s.rollout);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(pinnedConnection(s.root, SID), H('a'));
  s.boundary = FIX.split('\n').length - 1;
  if (!move) return s;
  useConnection(s.root, H('b'), { sessionId: SID });
  appendFileSync(s.rollout, `${FIX.split('\n').slice(-3, -1).join('\n')}\n`);
  if (removeB) removeConnection(s.root, H('b'));
  return s;
}
const expected = (removeB) => (removeB ? null : H('b'));
const now = (s) => ({ sends: sessionConnection(s.root, { sessionId: SID, env: {} }), a: sessionLines(s.root, SID, H('a')) });
const pinFile = (s, sid = SID) => join(s.root, 'state', 'sessions', `${sid}.json`);

for (const removeB of [false, true]) {
  const what = removeB ? 'pinned to none' : 'moved to B';
  test(`compressed rollout: a session ${what}, its rollout untouched, keeps its pin across another start`, async () => {
    const s = await setup({ removeB });
    await sessionStart(s, OTHER, join(s.dir, 'other.jsonl'));
    await sessionStart(s, SID, s.rollout);
    assert.deepEqual(now(s), { sends: expected(removeB), a: [[0, s.boundary]] });
  });

  test(`compressed rollout: a session ${what}, compressed in place and resumed under the .zst path, keeps its pin`, async () => {
    const s = await setup({ removeB });
    renameSync(s.rollout, `${s.rollout}.zst`);
    const r = await sessionStart(s, SID, `${s.rollout}.zst`);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(now(s), { sends: expected(removeB), a: [[0, s.boundary]] });
  });

  test(`compressed rollout: a session ${what}, compressed while another session starts and materialised on resume, keeps its pin`, async () => {
    const s = await setup({ removeB });
    renameSync(s.rollout, `${s.rollout}.zst`);
    await sessionStart(s, OTHER, join(s.dir, 'other.jsonl'));
    assert.ok(existsSync(pinFile(s)), 'the other start left the pin');
    renameSync(`${s.rollout}.zst`, s.rollout);
    await sessionStart(s, SID, s.rollout);
    assert.deepEqual(now(s), { sends: expected(removeB), a: [[0, s.boundary]] });
  });
}

test('compressed rollout: a rollout deleted under every spelling prunes its pin at the next start', async () => {
  const s = await setup();
  rmSync(s.rollout);
  await sessionStart(s, OTHER, join(s.dir, 'other.jsonl'));
  assert.equal(existsSync(pinFile(s)), false);
});

test('compressed rollout: archived_sessions keeps the pin and resumes on the moved-to connection', async () => {
  const s = await setup();
  const archived = join(s.codexHome, 'archived_sessions');
  mkdirSync(archived, { recursive: true });
  renameSync(s.rollout, join(archived, rolloutName(SID)));
  await sessionStart(s, OTHER, join(s.dir, 'other.jsonl'));
  assert.ok(existsSync(pinFile(s)), 'the archived rollout kept the pin');
  renameSync(join(archived, rolloutName(SID)), s.rollout);
  await sessionStart(s, SID, s.rollout);
  assert.deepEqual(now(s), { sends: H('b'), a: [[0, s.boundary]] });
});

test('compressed rollout: a move while only the .zst exists is refused, pins and segments unchanged', async () => {
  const s = await setup({ move: false });
  renameSync(s.rollout, `${s.rollout}.zst`);
  const before = readFileSync(pinFile(s), 'utf8');
  assert.throws(() => useConnection(s.root, H('b'), { sessionId: SID }), (e) => e.code === 'ETRANSCRIPTCOMPRESSED');
  assert.equal(readFileSync(pinFile(s), 'utf8'), before);
  const prev = process.env.WYBE_CONNECT_HOME;
  process.env.WYBE_CONNECT_HOME = s.home;
  const out = { text: '', write(x) { this.text += x; } };
  const err = { text: '', write(x) { this.text += x; } };
  try {
    const code = await runConnect({ harness: 'codex', clientName: 'x', argv: ['use', H('b'), '--session', SID], out, err, nextSteps: () => '' });
    assert.equal(code, 1);
  } finally {
    if (prev === undefined) delete process.env.WYBE_CONNECT_HOME;
    else process.env.WYBE_CONNECT_HOME = prev;
  }
  assert.match(err.text, /compressed/);
  assert.match(err.text, /resume/i);
  assert.equal(out.text, '');
  assert.equal(readFileSync(pinFile(s), 'utf8'), before);
  assert.equal(pinnedConnection(s.root, SID), H('a'));
});

test('compressed rollout: recordTranscript stores the .jsonl spelling, so a later move counts the uncompressed lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-zst-'));
  const root = join(dir, 'codex');
  saveConnection(root, grant('b'));
  saveConnection(root, grant('a'));
  useConnection(root, H('a'));
  const rollout = join(dir, rolloutName(SID));
  sessionPaths(root, { sessionId: SID, env: {} });
  writeFileSync(`${rollout}.zst`, FIX);
  recordTranscript(root, SID, `${rollout}.zst`);
  assert.equal(JSON.parse(readFileSync(join(root, 'state', 'sessions', `${SID}.json`), 'utf8')).transcriptPath, rollout);
  renameSync(`${rollout}.zst`, rollout);
  const lines = FIX.split('\n').length - 1;
  useConnection(root, H('b'), { sessionId: SID });
  assert.deepEqual({ a: sessionLines(root, SID, H('a')), b: sessionLines(root, SID, H('b')) }, { a: [[0, lines]], b: [[lines, null]] });
  recordTranscript(root, SID, `${rollout}`);
  writeFileSync(`${rollout}.zst`, FIX);
  recordTranscript(root, SID, `${rollout}.zst`);
  assert.equal(JSON.parse(readFileSync(join(root, 'state', 'sessions', `${SID}.json`), 'utf8')).transcriptPath, rollout, 'a .zst never replaces the .jsonl');
});

test('compressed rollout: rolloutSessionIds reads session ids from rollout file names under sessions and archived_sessions', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'wybe-connect-zst-'));
  const day = join(codexHome, 'sessions', '2026', '01', '02');
  const archived = join(codexHome, 'archived_sessions');
  mkdirSync(day, { recursive: true });
  mkdirSync(archived, { recursive: true });
  writeFileSync(join(day, rolloutName(SID)), '');
  writeFileSync(join(archived, `${rolloutName(OTHER)}.zst`), '');
  writeFileSync(join(day, 'notes.jsonl'), '');
  writeFileSync(join(day, 'rollout-2026-01-02T09-00-00-not-a-uuid.jsonl'), '');
  assert.deepEqual([...R.rolloutSessionIds(codexHome)].sort(), [SID, OTHER].sort());
  assert.equal(R.rolloutSessionIds(join(codexHome, 'missing')).size, 0);
  assert.equal(R.rolloutSessionIds(null).size, 0);
});

test('compressed rollout: 5000 rollout names are indexed well inside the hook budget', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'wybe-connect-zst-'));
  const hex = (i, n) => i.toString(16).padStart(n, '0');
  for (let d = 0; d < 50; d++) {
    const day = join(codexHome, 'sessions', '2026', hex(1 + Math.floor(d / 28), 2), hex(1 + (d % 28), 2));
    mkdirSync(day, { recursive: true });
    for (let i = 0; i < 100; i++) writeFileSync(join(day, rolloutName(`0190c0de-0000-7000-8000-${hex(d * 100 + i, 12)}`)), '');
  }
  const t0 = performance.now();
  const ids = R.rolloutSessionIds(codexHome);
  const ms = performance.now() - t0;
  assert.equal(ids.size, 5000);
  assert.ok(ms < 2500, `indexing took ${Math.round(ms)} ms`);
});
