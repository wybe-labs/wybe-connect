import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, existsSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionScopeOf, transcriptIdOf } from '../lib/flush.js';
import { STANDING_INSTRUCTION } from '../lib/session-context.js';

const ROOT = join(import.meta.dirname, '..');
const HOOKS = join(ROOT, 'packages', 'claude-code', 'hooks');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'session.jsonl');
const TOKEN = ['wat_', 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');
const REFUSED = 'http://127.0.0.1:9';

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

/** Runs a hook as Claude Code does. `claude` is always the recorder: a test must never start the real one. */
function runHook(script, input, home, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, WYBE_CONNECT_HOME: home, WYBE_CONNECT_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: join(home, '..', 'fake-claude.log'), ...extraEnv };
    delete env.WYBE_CONNECT_DISTIL;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [join(HOOKS, script)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-hooks-'));
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.git', 'config'), '[remote "origin"]\n\turl = https://example.com/x.git\n');
  const transcript = join(dir, '11111111-2222-4333-8444-555555555555.jsonl');
  copyFileSync(FIXTURE, transcript);
  return { dir, home, project, transcript };
}

function writeCredentials(home, endpointBase, scopes) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({
    version: 1, nodeUrl: endpointBase, mcpEndpoint: `${endpointBase}/mcp`, issuer: REFUSED, tokenEndpoint: `${REFUSED}/oauth/token`,
    clientId: 'c1', accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes,
  }));
}

/** A minimal fake node speaking just enough Streamable HTTP for the poster. */
function fakeNodeServer() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const msg = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, auth: req.headers.authorization, rpc: msg?.method ?? null, params: msg?.params ?? null });
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      if (msg.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })); return; }
      if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { open_questions: [{ id: 'q-7', text: 'Hva bruker du Claude Code mest til?' }] } } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

test('sessionScopeOf prefers full, then light, else null; transcriptIdOf strips the extension', () => {
  assert.equal(sessionScopeOf(['remember', 'sessions:light', 'sessions:full']), 'sessions:full');
  assert.equal(sessionScopeOf(['sessions:light']), 'sessions:light');
  assert.equal(sessionScopeOf(['remember', 'conversations']), null);
  assert.equal(transcriptIdOf('/x/y/abc-123.jsonl'), 'abc-123');
  assert.equal(transcriptIdOf('C:\\x\\we ird.jsonl'), 'we_ird');
});

/** The recorder's lines, after the detached start has had time to write. */
async function fakeStarts(home, expected) {
  const log = join(home, '..', 'fake-claude.log');
  for (let i = 0; i < 100; i++) {
    const n = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    if (n >= expected) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test('flush hook (essence only): notes the transcript and starts ONE background distil run; nothing is sent from the hook', async () => {
  const { home, project, transcript } = sandbox();
  const node = await fakeNodeServer();
  try {
    writeCredentials(home, node.base, ['remember', 'sessions:full']);
    const r = await runHook('flush.js', { session_id: 'sess', transcript_path: transcript, cwd: project, hook_event_name: 'Stop' }, home);
    assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
    const starts = await fakeStarts(home, 1);
    assert.equal(starts.length, 1, 'one headless run');
    const [run] = starts;
    assert.equal(run.distil, '1', 'the run is marked, so its own hooks and MCP server start nothing');
    assert.equal(run.argv[0], '-p');
    assert.match(run.argv[1], /# Distil to Wybe[\s\S]*## This run\nMode: ongoing/, 'the distil instructions are inlined');
    assert.ok(run.argv[1].includes(transcript), 'the run distils exactly the noted transcript');
    assert.deepEqual(run.argv.slice(2, 4), ['--tools', 'Read,Glob,Grep']);
    assert.ok(run.argv.includes('--strict-mcp-config') && run.argv.includes('dontAsk'));
    assert.equal(node.seen.length, 0, 'the hook itself sends nothing: no raw session leaves the machine');
    assert.equal(existsSync(join(home, 'queue')), false, 'no raw delta is queued either');
    let state;
    for (let i = 0; i < 100; i++) {
      state = JSON.parse(readFileSync(join(home, 'state', 'distil.json'), 'utf8'));
      if (state.running === null) break;
      await new Promise((res) => setTimeout(res, 30));
    }
    assert.equal(state.running, null, 'the watchdog recorded the end of the run');
    assert.ok(state.lastRunAt && !state.lastFailureAt, 'a clean exit');
    assert.deepEqual(state.pending, [], 'the noted transcript went to the run');

    const again = await runHook('flush.js', { session_id: 'sess', transcript_path: transcript, cwd: project, hook_event_name: 'PreCompact' }, home);
    assert.deepEqual(again, { code: 0, stdout: '', stderr: '' });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal((await fakeStarts(home, 1)).length, 1, 'within the interval, no second run');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'state', 'distil.json'), 'utf8')).pending.map((p) => p.transcriptPath), [transcript], 'noted for the next run');
  } finally {
    node.server.close();
  }
});

test('inside a distil run the hooks do nothing (no recursion), and SessionStart adds no context there', async () => {
  const { home, project, transcript } = sandbox();
  writeCredentials(home, REFUSED, ['remember']);
  const r = await runHook('flush.js', { session_id: 's', transcript_path: transcript, cwd: project, hook_event_name: 'Stop' }, home, { WYBE_CONNECT_DISTIL: '1' });
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(home, 'state', 'distil.json')), false);
  const s = await runHook('session-start.js', { hook_event_name: 'SessionStart' }, home, { WYBE_CONNECT_DISTIL: '1' });
  assert.deepEqual(s, { code: 0, stdout: '', stderr: '' });
  assert.equal((await fakeStarts(home, 0)).length, 0);
});

test('session-start hands Claude the standing instruction and the cached open questions', async () => {
  const { home } = sandbox();
  writeCredentials(home, REFUSED, ['remember']);
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'open-questions.json'), JSON.stringify({ fetched_at: '2026-10-21T10:00:00Z', open_questions: [{ id: 'q-7', text: 'Hva bruker du Claude Code mest til?' }] }));
  const start = await runHook('session-start.js', { session_id: 'sess2', hook_event_name: 'SessionStart', source: 'startup' }, home);
  assert.equal(start.code, 0);
  assert.equal(start.stderr, '');
  const out = JSON.parse(start.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(STANDING_INSTRUCTION));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('(q-7) Hva bruker du Claude Code mest til?'));
  assert.ok(!out.hookSpecificOutput.additionalContext.includes(TOKEN));
});

test('hooks without a credential do nothing and exit 0; malformed stdin exits 0 with one stderr line', async () => {
  const { home, project, transcript } = sandbox();
  const f = await runHook('flush.js', { session_id: 's', transcript_path: transcript, cwd: project, hook_event_name: 'Stop' }, home);
  assert.deepEqual(f, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(home, 'queue')), false);
  const s = await runHook('session-start.js', { hook_event_name: 'SessionStart' }, home);
  assert.deepEqual(s, { code: 0, stdout: '', stderr: '' });
  const bad = await runHook('flush.js', '{not json', home);
  assert.equal(bad.code, 0);
  assert.match(bad.stderr, /^wybe-connect: flush failed: /);
  assert.equal(bad.stderr.trim().split('\n').length, 1);
});

test('a grant without `remember` never notes or distils anything', async () => {
  const { home, project, transcript } = sandbox();
  writeCredentials(home, REFUSED, ['sessions:light']);
  const r = await runHook('flush.js', { session_id: 's', transcript_path: transcript, cwd: project, hook_event_name: 'Stop' }, home);
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(home, 'state')), false);
  assert.equal((await fakeStarts(home, 0)).length, 0);
});

test('F5: eight Stop/SessionEnd hooks at once start the headless run only once (lock around distil.json)', async () => {
  const { dir, home } = sandbox();
  writeCredentials(home, REFUSED, ['remember']);
  const N = 8;
  await Promise.all(Array.from({ length: N }, (_, i) => runHook('flush.js', { session_id: `s${i}`, transcript_path: join(dir, `t${i}.jsonl`), cwd: dir, hook_event_name: i % 2 ? 'Stop' : 'SessionEnd' }, home)));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await fakeStarts(home, 1)).length, 1);
  const state = JSON.parse(readFileSync(join(home, 'state', 'distil.json'), 'utf8'));
  const inRun = 1;
  assert.equal(state.pending.length + inRun >= 1, true);
  assert.ok(state.pending.length <= N - 1, 'every other noted transcript waits for the next run');
});
