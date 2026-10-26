// The Claude Code hooks as real processes. They send nothing themselves (essence only): the Stop
// hook notes the transcript and the scheduler starts the background distil. Every hook here runs
// with WYBE_CONNECT_CLAUDE_BIN set to test/fixtures/fake-distil-claude.mjs, so no test can start
// the real claude (#4 started three by accident before its recorder existed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { sessionScopeOf, transcriptIdOf } from '../lib/flush.js';
import { STANDING_INSTRUCTION } from '../lib/session-context.js';

const ROOT = join(import.meta.dirname, '..');
const PKG = join(ROOT, 'packages', 'claude-code');
const HOOKS = join(PKG, 'hooks');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'session.jsonl');
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-distil-claude.mjs');
const HOLDER = join(import.meta.dirname, 'fixtures', 'slow-holder.mjs');
const TOKEN = ['wat_', 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');
const REFUSED = 'http://127.0.0.1:9';
const D = await import(pathToFileURL(join(PKG, 'lib', 'distil.js')).href);
const { paths } = await import(pathToFileURL(join(PKG, 'lib', 'home.js')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t = Date.now(); for (;;) { const x = fn(); if (x) return x; if (Date.now() - t > ms) return null; await sleep(100); } }

function runHook(script, input, home, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, WYBE_CONNECT_HOME: home, WYBE_CONNECT_CLAUDE_BIN: FAKE, ...extraEnv };
    const child = spawn(process.execPath, [join(HOOKS, script)], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
  mkdirSync(project, { recursive: true });
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

/** A fake node: records every call; remember answers ok with a numeric stored. */
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
      const stored = msg.params?.arguments?.items?.length ?? 0;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, stored, open_questions: [] }) }] } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

const stop = (transcript, project, i = 0) => ({ session_id: `sess-${i}`, transcript_path: transcript, cwd: project, hook_event_name: 'Stop' });
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('sessionScopeOf prefers full, then light, else null; transcriptIdOf strips the extension', () => {
  assert.equal(sessionScopeOf(['remember', 'sessions:light', 'sessions:full']), 'sessions:full');
  assert.equal(sessionScopeOf(['sessions:light']), 'sessions:light');
  assert.equal(sessionScopeOf(['remember', 'conversations']), null);
  assert.equal(transcriptIdOf('/x/y/abc-123.jsonl'), 'abc-123');
  assert.equal(transcriptIdOf('C:\\x\\we ird.jsonl'), 'we_ird');
});

test('Stop hook: sends nothing itself, notes the session and starts one distil run, whose essence reaches the node', async () => {
  const { dir, home, project, transcript } = sandbox();
  const node = await fakeNodeServer();
  try {
    writeCredentials(home, node.base, ['remember', 'sessions:full']);
    const log = join(dir, 'fake.log');
    const r = await runHook('flush.js', stop(transcript, project), home, { FAKE_LOG: log });
    assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
    const p = paths(home);
    await waitFor(() => D.loadState(p).lastSuccessAt);
    assert.equal(lines(log), 1, 'one headless run');
    const calls = node.seen.filter((c) => c.rpc === 'tools/call');
    assert.deepEqual(calls.map((c) => c.params.name), ['remember'], 'no report_session: only the distilled facts');
    assert.deepEqual(calls[0].params.arguments.items, [{ content: 'Fact 1 of 1.', subject: 'project' }]);
    assert.ok(!JSON.stringify(node.seen).includes('PLANTED-ASSISTANT-SENTENCE'), 'nothing raw from the transcript');
    for (const c of node.seen) assert.equal(c.auth, `Bearer ${TOKEN}`);

    // within the 6 h interval the next Stop starts nothing
    const again = await runHook('flush.js', stop(transcript, project), home, { FAKE_LOG: log });
    assert.equal(again.code, 0);
    await sleep(1500);
    assert.equal(lines(log), 1);
  } finally {
    node.server.close();
  }
});

test('the real path (hook -> detached bin/distil-run.js -> fake claude -> bin/mcp-proxy.js): node down means no success, and the facts wait', async () => {
  const { dir, home, project, transcript } = sandbox();
  writeCredentials(home, REFUSED, ['remember']);
  const log = join(dir, 'fake.log');
  const r = await runHook('flush.js', stop(transcript, project), home, { FAKE_LOG: log, FAKE_CALLS: '2' });
  assert.equal(r.code, 0);
  const p = paths(home);
  const s = await waitFor(() => { const x = D.loadState(p); return x.lastFailureAt && x.running === null ? x : null; });
  assert.ok(s, 'the run finished');
  assert.ok(JSON.parse(readFileSync(log, 'utf8').trim()).tools.includes('remember'), 'remember was offered with the node down');
  assert.equal(s.lastSuccessAt, null);
  assert.equal(s.lastError.class, 'node-unreachable');
  assert.ok(s.outbox, 'the two calls wait in the outbox');
});

test('8 parallel Stop hooks start exactly one run', async () => {
  const { dir, home, project, transcript } = sandbox();
  writeCredentials(home, REFUSED, ['remember']);
  const log = join(dir, 'fake.log');
  const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => runHook('flush.js', stop(transcript, project, i), home, { FAKE_LOG: log, FAKE_DONE: '0' })));
  for (const r of runs) assert.equal(r.code, 0, r.stderr);
  const p = paths(home);
  await waitFor(() => lines(log) >= 1 && D.loadState(p).running === null);
  await sleep(500);
  assert.equal(lines(log), 1);
});

test('four real Stop hooks during a live holder\'s 6 s critical section keep all their notes', async () => {
  const { home, project } = sandbox();
  writeCredentials(home, REFUSED, ['remember']);
  const p = paths(home);
  // A recent failure: the back-off keeps a hook that gets the lock after the holder from starting a run.
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'distil.json'), JSON.stringify({ version: 2, lastFailureAt: new Date().toISOString(), lastError: { class: 'node-unreachable', message: 'x', at: new Date().toISOString() } }));
  const holder = spawn(process.execPath, [HOLDER, home, '6000'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const exited = new Promise((r) => holder.on('exit', r));
  let out = '';
  holder.stdout.on('data', (c) => { out += c; });
  assert.ok(await waitFor(() => out.includes('HOLDING'), 10000));
  const transcripts = [0, 1, 2, 3].map((i) => join(home, '..', `aaaaaaaa-0000-4000-8000-00000000000${i}.jsonl`));
  for (const t of transcripts) writeFileSync(t, '{"type":"user"}\n');
  const hooks = await Promise.all(transcripts.map((t, i) => runHook('flush.js', stop(t, project, i), home)));
  for (const h of hooks) assert.equal(h.code, 0, h.stderr);
  await exited;
  assert.ok(out.includes('HOLDER done'), out);
  const view = new Set(D.pendingView(p).map((x) => x.path));
  for (const t of transcripts) assert.ok(view.has(t), `${t} survived the holder's late write`);
  assert.ok(view.has('C:\\holder\\written-after-the-pause.jsonl'), 'the holder\'s own write stands too');
});

test('inside a distil run the hooks do nothing', async () => {
  const { home, project, transcript } = sandbox();
  writeCredentials(home, REFUSED, ['remember']);
  const r = await runHook('flush.js', stop(transcript, project), home, { WYBE_CONNECT_DISTIL: 'r-1' });
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(home, 'state')), false);
  const s = await runHook('session-start.js', { hook_event_name: 'SessionStart' }, home, { WYBE_CONNECT_DISTIL: 'r-1' });
  assert.deepEqual(s, { code: 0, stdout: '', stderr: '' });
});

test('hooks without a credential do nothing and exit 0; malformed stdin exits 0 with one stderr line', async () => {
  const { home, project, transcript } = sandbox();
  const f = await runHook('flush.js', stop(transcript, project), home);
  assert.deepEqual(f, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(home, 'state')), false);
  const s = await runHook('session-start.js', { hook_event_name: 'SessionStart' }, home);
  assert.deepEqual(s, { code: 0, stdout: '', stderr: '' });
  const bad = await runHook('flush.js', '{not json', home);
  assert.equal(bad.code, 0);
  assert.match(bad.stderr, /^wybe-connect: flush failed: /);
  assert.equal(bad.stderr.trim().split('\n').length, 1);
});

test('a grant without remember notes nothing and starts nothing', async () => {
  const { home, project, transcript } = sandbox();
  writeCredentials(home, REFUSED, ['sessions:light']);
  const r = await runHook('flush.js', stop(transcript, project), home);
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(home, 'state')), false);
});

test('SessionStart: the standing instruction and the cached open questions, and a distil problem told once', async () => {
  const { home } = sandbox();
  writeCredentials(home, REFUSED, ['remember']);
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'open-questions.json'), JSON.stringify({ open_questions: [{ id: 'q-7', text: 'Hva bruker du Claude Code mest til?' }] }));
  writeFileSync(join(home, 'state', 'distil.json'), JSON.stringify({ version: 2, lastError: { class: 'node-unreachable', message: 'network: ECONNREFUSED', at: new Date().toISOString() } }));
  const start = await runHook('session-start.js', { session_id: 'sess2', hook_event_name: 'SessionStart', source: 'startup' }, home);
  assert.equal(start.code, 0);
  assert.equal(start.stderr, '');
  const ctx = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(STANDING_INSTRUCTION));
  assert.ok(ctx.includes('(q-7) Hva bruker du Claude Code mest til?'));
  assert.match(ctx, /could not be reached/);
  assert.ok(!ctx.includes(TOKEN));
  const next = await runHook('session-start.js', { session_id: 'sess3', hook_event_name: 'SessionStart', source: 'startup' }, home);
  assert.doesNotMatch(JSON.parse(next.stdout).hookSpecificOutput.additionalContext, /could not be reached/, 'told once');
});
