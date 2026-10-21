// QA round 3's falsifier proofs for the distil runner (wybe-labs/wybe-connect #4), kept as
// regression tests: each one failed on 2c30967 and must pass from now on. No test starts the real
// claude: the headless run is a fake in test/fixtures (mcp-claude.mjs, multi-claude.mjs, via
// WYBE_CONNECT_CLAUDE_BIN or an explicit `resolve`), new runs are recorded, and the node is an
// in-process HTTP fake on 127.0.0.1 or the closed port 127.0.0.1:9.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = join(import.meta.dirname, '..');
const PKG = join(REPO, 'packages', 'claude-code');
const FAKES = join(import.meta.dirname, 'fixtures');
const lib = (f) => import(pathToFileURL(join(PKG, 'lib', f)).href);
const D = await lib('distil.js');
const { paths, saveCredentials, writeJsonPrivate } = await lib('home.js');

const MIN = 60 * 1000;
const H = 60 * MIN;
const AT = '2026-10-21T09:59:00.000Z';
const home = () => paths(mkdtempSync(join(tmpdir(), 'qa-connect-r3-')));
const fakeTok = (ch) => ['wat', ch.repeat(40)].join('_');
const creds = (endpoint) => ({ nodeUrl: 'https://demo.wybe.me', resource: endpoint, mcpEndpoint: endpoint, issuer: 'https://auth.wybe.me', tokenEndpoint: 'https://auth.wybe.me/oauth/token', clientId: 'c1', accessToken: fakeTok('x'), refreshToken: null, expiresAt: null, scopes: ['remember'] });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t = Date.now(); for (;;) { const x = fn(); if (x) return x; if (Date.now() - t > ms) return null; await sleep(100); } }
const killLater = [];
after(() => { for (const pid of killLater) if (alive(pid)) { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid); } });
const recorder = () => { const spawns = []; return { spawns, spawnImpl: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { pid: 4242, on() {}, unref() {} }; } }; };
const transcript = (i) => `C:\\Users\\person\\.claude\\projects\\C--work-demo\\00000000-0000-4000-8000-${String(i).padStart(12, '0')}.jsonl`;

/** An MCP node over real HTTP on 127.0.0.1. `answers` is the reply to each tools/call in turn: 'ok', 'done' (import_done: true) or a status code. */
async function httpNode(answers) {
  let n = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      const json = (o, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method !== 'tools/call') { res.writeHead(200); return res.end(); } // session DELETE etc.
      const a = answers[n++] ?? 'ok';
      if (typeof a === 'number') { res.writeHead(a); return res.end('upstream error'); }
      return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, stored: 1, ...(a === 'done' ? { import_done: true } : {}) }) }] } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => server.close() };
}

// ------------------------------------------------------------------ R2-1, ongoing mode
test('QA R3-3: an ongoing run that delivered nothing (node unreachable, claude -p exits 0) drops its transcripts for good', async () => {
  const p = home();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), p); // the laptop is offline during the run
  for (let i = 0; i < 3; i++) D.noteSession(p, { transcriptPath: transcript(i), now: Date.now() - H });
  const log = join(p.root, 'fake.log');
  process.env.FAKE_LOG = log;
  process.env.WYBE_CONNECT_CLAUDE_BIN = join(FAKES, 'mcp-claude.mjs');
  // The real path: maybeRun -> startRun -> detached bin/distil-run.js -> runWatchdog -> fake claude -> plugin's mcp-proxy.js.
  const plan = D.maybeRun({ paths: p, env: {} });
  delete process.env.FAKE_LOG; delete process.env.WYBE_CONNECT_CLAUDE_BIN;
  assert.equal(plan?.mode, 'ongoing');
  const done = await waitFor(() => existsSync(log) && D.loadState(p).running === null ? D.loadState(p) : null);
  assert.ok(done, 'the run finished');
  const ran = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  console.log('remember answer inside the run:', JSON.stringify(ran[0].answer));
  console.log('after the run: pending =', done.pending.length, '| lastFailureAt =', done.lastFailureAt, '| lastError =', done.lastError);
  assert.equal(ran[0].answer.isError, true, 'precondition: nothing reached the node');
  const kept = new Set(done.pending.map((x) => x.transcriptPath));
  assert.ok([0, 1, 2].every((i) => kept.has(transcript(i))), 'the 3 undelivered transcripts are gone: no failure recorded, never distilled again');
});

// ------------------------------------------------------------------ R2-1, import with a 5xx mid-way
test('QA R3-4: an import whose 2nd of 3 remember calls got HTTP 502 is still recorded as handled (partial import, never retried)', async () => {
  const p = home();
  const node = await httpNode(['ok', 502, 'done']);
  saveCredentials(creds(node.url), p);
  const log = join(p.root, 'fake.log');
  process.env.FAKE_LOG = log; process.env.FAKE_CALLS = '3';
  const planFile = join(p.state, 'distil-plan-x.json');
  writeJsonPrivate(planFile, { plan: { mode: 'import', importOf: AT, transcripts: null }, log: join(p.state, 'distil-x.log'), root: p.root });
  const outcome = await D.runWatchdog(planFile, { paths: p, resolve: () => ({ cmd: process.execPath, pre: [join(FAKES, 'multi-claude.mjs')] }) });
  delete process.env.FAKE_LOG; delete process.env.FAKE_CALLS;
  node.close();
  const ran = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const r of ran) console.log(`call ${r.call} import_of=${r.importOf}:`, JSON.stringify(r.answer).slice(0, 120));
  console.log('watchdog outcome:', JSON.stringify(outcome), '| importHandled:', D.loadState(p).importHandled);
  assert.equal(ran[1].answer.isError, true, 'precondition: batch 2 never reached the node');
  assert.notEqual(D.loadState(p).importHandled, AT, 'the import is closed although one of its batches was "Not delivered" inside the same run');
});

// ------------------------------------------------------------------ R2-3: once, and clears after a fix
test('QA R3-5: the distil problem is injected into EVERY session start, not once', () => {
  const p = home();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), p);
  const now = new Date().toISOString();
  writeJsonPrivate(join(p.state, 'distil.json'), { lastRunAt: now, lastFailureAt: now, lastError: 'claude not found on PATH (set WYBE_CONNECT_CLAUDE_BIN)', running: null, pending: [], importHandled: null });
  let shown = 0;
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(process.execPath, [join(PKG, 'hooks', 'session-start.js')], { input: JSON.stringify({ session_id: `s${i}`, hook_event_name: 'SessionStart', source: 'startup' }), env: { ...process.env, WYBE_CONNECT_HOME: p.root }, encoding: 'utf8' });
    if (r.stdout.includes('could not run its background distil')) shown += 1;
  }
  console.log(`3 session starts in a row: the problem was injected into ${shown}`);
  assert.ok(shown <= 1, `told ${shown} times`);
});

test('QA R3-6: after a failed ongoing run is fixed, nothing retries for 6 h (not the 30 min back-off), so the SessionStart problem stays', async () => {
  const p = home();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), p);
  for (let i = 0; i < 2; i++) D.noteSession(p, { transcriptPath: transcript(i), now: Date.now() - H });
  const T = Date.now();
  const planFile = join(p.state, 'distil-plan-y.json');
  const started = D.maybeRun({ paths: p, env: {}, now: T, ...recorder() });
  assert.equal(started?.mode, 'ongoing');
  writeJsonPrivate(planFile, { plan: { mode: 'ongoing', importOf: null, transcripts: started.transcripts }, log: join(p.state, 'distil-y.log'), root: p.root });
  { const s = D.loadState(p); s.running.pid = process.pid; writeJsonPrivate(join(p.state, 'distil.json'), s); } // this process plays the watchdog
  // claude is missing (R2-3's case): the run fails, the transcripts go back.
  await D.runWatchdog(planFile, { paths: p, resolve: () => null, now: () => T });
  assert.ok(D.distilProblem(p, T + MIN), 'precondition: the problem is recorded');
  // The person fixes it a minute later. Hooks fire 31 min, 2 h and 5 h later.
  const rec = recorder();
  const tries = [31 * MIN, 2 * H, 5 * H].map((dt) => ({ dt, plan: D.maybeRun({ paths: p, env: {}, now: T + dt, isAlive: () => false, ...rec }) }));
  console.log(tries.map((t) => `+${Math.round(t.dt / MIN)} min: ${t.plan ? 'run started' : 'no run'}`).join(' | '), '| still shown at +5 h:', !!D.distilProblem(p, T + 5 * H));
  assert.ok(tries[0].plan, 'no retry 31 min after the failure, although FAILURE_BACKOFF_MS is 30 min');
});

// ------------------------------------------------------------------ stale run: the dead watchdog's transcripts
test('QA R3-7: a run whose watchdog died (reboot, crash) loses its transcripts: the next run replaces the record and they are never distilled', async () => {
  const p = home();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), p);
  for (let i = 0; i < 3; i++) D.noteSession(p, { transcriptPath: transcript(i), now: Date.now() - 7 * H });
  const T0 = Date.now() - 5 * MIN; // the run started 5 min before the reboot
  const first = D.maybeRun({ paths: p, env: {}, now: T0, ...recorder() });
  assert.equal(first?.transcripts.length, 3);
  // A real process holds that pid and dies: the reboot.
  const c = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => c.on('exit', r));
  const s = D.loadState(p); s.running.pid = c.pid; writeJsonPrivate(join(p.state, 'distil.json'), s);
  assert.equal(alive(c.pid), false);
  D.noteSession(p, { transcriptPath: transcript(9), now: Date.now() });
  const rec = recorder();
  const next = D.maybeRun({ paths: p, env: {}, now: Date.now(), ...rec });
  const after = D.loadState(p);
  const everywhere = new Set([...after.pending.map((x) => x.transcriptPath), ...(after.running?.transcripts ?? [])]);
  console.log('next run takes:', next?.transcripts?.length, '| the dead run\'s 3 transcripts still known:', [0, 1, 2].filter((i) => everywhere.has(transcript(i))).length);
  assert.ok(next, 'precondition: distil is not stuck');
  assert.ok([0, 1, 2].every((i) => everywhere.has(transcript(i))), 'the dead run\'s transcripts vanished from distil.json');
});
