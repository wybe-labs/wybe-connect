// QA round 4's falsifier proofs for the distil runner (wybe-labs/wybe-connect #4), kept as
// regression tests: each one failed on c67c8db and must pass from now on. No test starts the real
// claude: the headless run is a fake in test/fixtures, and the node is an in-process HTTP fake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
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
const home = () => paths(mkdtempSync(join(tmpdir(), 'qa-connect-r4-')));
const fakeTok = (ch) => ['wat', ch.repeat(40)].join('_');
const creds = (endpoint) => ({ nodeUrl: 'https://demo.example.test', resource: endpoint, mcpEndpoint: endpoint, issuer: 'https://auth.example.test', tokenEndpoint: 'https://auth.example.test/oauth/token', clientId: 'c1', accessToken: fakeTok('x'), refreshToken: null, expiresAt: null, scopes: ['remember'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t = Date.now(); for (;;) { const x = fn(); if (x) return x; if (Date.now() - t > ms) return null; await sleep(100); } }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killLater = [];
after(() => { for (const pid of killLater) if (alive(pid)) { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid); } });
const recorder = () => { const spawns = []; return { spawns, spawnImpl: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { pid: 4242, on() {}, unref() {} }; } }; };
const transcript = (i) => `C:\\Users\\person\\.claude\\projects\\C--work-demo\\00000000-0000-4000-8000-${String(i).padStart(12, '0')}.jsonl`;
const statePath = (p) => join(p.state, 'distil.json');

/**
 * An MCP node over real HTTP. `answers` is the reply to each tools/call in turn: 'ok' (stored and
 * answered), a status code (NOT stored), or {delayMs} (stored at once, answered after delayMs).
 * `stored` lists every item text the node kept.
 */
async function httpNode(answers) {
  let n = 0;
  const stored = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      const json = (o, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remember', inputSchema: { type: 'object' } }, { name: 'pending_questions', inputSchema: { type: 'object' } }] } });
      if (msg.method !== 'tools/call') { res.writeHead(200); return res.end(); } // session DELETE etc.
      const a = answers[n++] ?? 'ok';
      if (typeof a === 'number') { res.writeHead(a); return res.end('upstream error'); }
      for (const it of msg.params?.arguments?.items ?? []) stored.push(it.text);
      const reply = () => json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, stored: 1 }) }] } });
      if (a?.delayMs) setTimeout(reply, a.delayMs); else reply();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, stored, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/** One ongoing run through the real runWatchdog, this process playing the watchdog. */
async function ongoingRun(p, { now, fake, env = {} }) {
  const plan = D.maybeRun({ paths: p, env: {}, now, isAlive: () => false, ...recorder() });
  if (!plan) return { plan: null };
  const s = D.loadState(p); s.running.pid = process.pid; writeJsonPrivate(statePath(p), s);
  const planFile = join(p.state, `distil-plan-r4-${now}.json`);
  writeJsonPrivate(planFile, { plan: { mode: 'ongoing', importOf: null, transcripts: plan.transcripts }, log: join(p.state, `distil-r4-${now}.log`), root: p.root });
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const outcome = await D.runWatchdog(planFile, { paths: p, now: () => now, resolve: fake ? () => ({ cmd: process.execPath, pre: [join(FAKES, fake)] }) : () => null });
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  return { plan, outcome };
}

// ------------------------------------------------------------------ R4-3: an empty ledger is a success
test('QA R4-3: a run in which nothing reached the node still counts as delivered when the server never offered remember (node down at tools/list) or was signed out', async () => {
  const results = [];
  for (const variant of ['node unreachable during the run', 'signed out during the run']) {
    const p = home();
    saveCredentials(creds('http://127.0.0.1:9/mcp'), p);
    for (let i = 0; i < 3; i++) D.noteSession(p, { transcriptPath: transcript(i), now: Date.now() - H });
    if (variant === 'signed out during the run') unlinkSync(p.credentials); // after the hooks noted (they need the grant)
    const log = join(p.root, 'fake.log');
    // The real path: maybeRun -> startRun -> detached bin/distil-run.js -> runWatchdog -> fake claude -> plugin's mcp-proxy.js.
    process.env.FAKE_LOG = log;
    process.env.WYBE_CONNECT_CLAUDE_BIN = join(FAKES, 'listing-claude.mjs');
    const plan = D.maybeRun({ paths: p, env: {} });
    delete process.env.FAKE_LOG; delete process.env.WYBE_CONNECT_CLAUDE_BIN;
    assert.equal(plan?.mode, 'ongoing');
    const done = await waitFor(() => existsSync(log) && D.loadState(p).running === null ? D.loadState(p) : null);
    assert.ok(done, 'the run finished');
    const ran = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]);
    const kept = [0, 1, 2].filter((i) => done.pending.some((x) => x.transcriptPath === transcript(i))).length;
    results.push(`${variant}: tools offered ${JSON.stringify(ran.tools)}, remember called: ${ran.calledRemember}; after: pending ${kept}/3, lastFailureAt ${done.lastFailureAt}, lastRunAt set ${!!done.lastRunAt}`);
    assert.equal(ran.calledRemember, false, 'precondition: nothing was sent');
  }
  console.log(results.join('\n'));
  assert.ok(results.every((r) => r.includes('pending 3/3')), 'the transcripts were dropped as delivered although nothing reached the node');
});

// ------------------------------------------------------------------ R4-4: delivered twice
test('QA R4-4: one lost remember (HTTP 502) or a node that stored but answered late re-sends every batch that WAS stored: the node keeps duplicates', async () => {
  const results = [];
  for (const [variant, firstRun] of [['2nd of 3 calls got HTTP 502', ['ok', 502, 'ok']], ['node stored call 1 but answered after 16 s (client timeout 15 s)', [{ delayMs: 16000 }, 'ok', 'ok']]]) {
    const p = home();
    const node = await httpNode([...firstRun, 'ok', 'ok', 'ok']);
    saveCredentials(creds(node.url), p);
    for (let i = 0; i < 3; i++) D.noteSession(p, { transcriptPath: transcript(i), now: Date.now() - 7 * H });
    const T = Date.now();
    const env = { FAKE_CALLS: '3', WYBE_CONNECT_HOME: p.root };
    const r1 = await ongoingRun(p, { now: T, fake: 'multi-claude.mjs', env });
    const r2 = await ongoingRun(p, { now: T + 31 * MIN, fake: 'multi-claude.mjs', env });
    node.close();
    const counts = {};
    for (const t of node.stored) counts[t] = (counts[t] ?? 0) + 1;
    const dupes = Object.entries(counts).filter(([, c]) => c > 1);
    results.push(`${variant}: run 1 ${JSON.stringify(r1.outcome)}; run 2 ${JSON.stringify(r2.outcome)}; node stored ${JSON.stringify(counts)}`);
    results.push(`  duplicates: ${dupes.length}`);
  }
  console.log(results.join('\n'));
  assert.ok(results.filter((l) => l.startsWith('  duplicates')).every((l) => l.endsWith(': 0')), 'facts the node already stored were sent and stored again (no idempotency key, the whole run is redone)');
});

// ------------------------------------------------------------------ R4-5: "once per error" repeats
test('QA R4-5: the same outage is told at every SessionStart whose run made a different number of remember calls', async () => {
  const p = home();
  const node = await httpNode(Array(20).fill(502)); // the node is down (502) the whole time
  saveCredentials(creds(node.url), p);
  for (let i = 0; i < 3; i++) D.noteSession(p, { transcriptPath: transcript(i), now: Date.now() - 7 * H });
  const T = Date.now();
  let told = 0;
  const errors = [];
  for (let k = 1; k <= 3; k++) {
    const r = await ongoingRun(p, { now: T + (k - 1) * 31 * MIN, fake: 'multi-claude.mjs', env: { FAKE_CALLS: String(k), WYBE_CONNECT_HOME: p.root } });
    errors.push(r.outcome?.error);
    const s = spawnSync(process.execPath, [join(PKG, 'hooks', 'session-start.js')], { input: JSON.stringify({ session_id: `s${k}`, hook_event_name: 'SessionStart', source: 'startup' }), env: { ...process.env, WYBE_CONNECT_HOME: p.root }, encoding: 'utf8' });
    if (s.stdout.includes('could not run its background distil')) told += 1; // the notice from lib/session-context.js
  }
  node.close();
  console.log(`errors: ${JSON.stringify(errors)}\nthe one outage was told at ${told} of 3 session starts`);
  assert.equal(told, 1, `told ${told} times: once, not never and not at every start`);
});

// ------------------------------------------------------------------ R4-6: overflow drops the failed run's transcripts
test('QA R4-6: with pending full (2000), a failed run\'s transcripts are pushed back at the front and cut by slice(-2000): lost without a trace', async () => {
  const p = home();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), p);
  const old = Date.now() - 7 * H;
  writeJsonPrivate(statePath(p), { importHandled: null, lastRunAt: null, lastFailureAt: null, lastError: null, running: null, pending: Array.from({ length: D.MAX_PENDING }, (_, i) => ({ transcriptPath: transcript(i), sessionId: null, cwd: null, at: new Date(old).toISOString() })) });
  const T = Date.now();
  const plan = D.maybeRun({ paths: p, env: {}, now: T, isAlive: () => false, ...recorder() });
  assert.equal(plan?.transcripts.length, D.MAX_RUN_TRANSCRIPTS);
  const s = D.loadState(p); s.running.pid = process.pid; writeJsonPrivate(statePath(p), s);
  // While the run works (up to 30 min), the person keeps working: 40 sessions end.
  for (let i = 0; i < 40; i++) D.noteSession(p, { transcriptPath: transcript(5000 + i), now: T + i * 1000 });
  const planFile = join(p.state, 'distil-plan-r4-full.json');
  writeJsonPrivate(planFile, { plan: { mode: 'ongoing', importOf: null, transcripts: plan.transcripts }, log: join(p.state, 'distil-r4-full.log'), root: p.root });
  const outcome = await D.runWatchdog(planFile, { paths: p, now: () => T + 20 * MIN, resolve: () => null }); // the run fails
  const after = D.loadState(p);
  const known = new Set(after.pending.map((x) => x.transcriptPath));
  const back = plan.transcripts.filter((t) => known.has(t)).length;
  console.log(`outcome: ${JSON.stringify(outcome)} | lastError: ${after.lastError} | pending: ${after.pending.length} | the failed run's ${plan.transcripts.length} transcripts still pending: ${back}`);
  assert.equal(back, plan.transcripts.length, 'the failed run\'s transcripts were dropped from pending, never distilled, nothing records it');
});

// ------------------------------------------------------------------ R4-8: one unreadable ledger line hides the failures
// Function level (the watchdog's own two calls, lib/distil.js runWatchdog → finish): what the run's
// MCP server wrote is a lost remember; a torn last line (disk full, the server killed mid-append)
// follows it.
test('QA R4-8: one unparseable ledger line makes readLedger return [], so a ledger that records a lost remember reads as success', () => {
  const p = home();
  mkdirSync(p.state, { recursive: true });
  const ledger = D.ledgerFor(join(p.state, 'distil-plan-2026-10-21T10-00-00-000Z.json'));
  D.recordDelivery(ledger, { tool: 'remember', ok: false, importOf: null, importDone: false });
  D.recordDelivery(ledger, { tool: 'remember', ok: true, importOf: null, importDone: false });
  const intact = D.ledgerVerdict({ mode: 'ongoing' }, D.readLedger(ledger));
  appendFileSync(ledger, '{"tool":"remember","ok":tr');
  const torn = D.ledgerVerdict({ mode: 'ongoing' }, D.readLedger(ledger));
  console.log(`verdict, intact ledger: ${JSON.stringify(intact)} | after one torn line: ${JSON.stringify(torn)} (null = success)`);
  assert.ok(intact, 'precondition: the lost remember is a failure');
  assert.ok(torn, 'the torn line erased the recorded failure: the run counts as delivered');
});

// ------------------------------------------------------------------ R4-7: stale-lock takeover of a LIVE holder
test('QA R4-7: a live holder slower than LOCK_STALE_MS (6 s) loses its lock to waiting hooks, then overwrites their notes (real processes)', async () => {
  const p = home();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), p);
  // A recent failure: the back-off keeps the hooks from starting any run (no claude, no tripwire).
  writeJsonPrivate(statePath(p), { importHandled: null, lastRunAt: null, lastFailureAt: new Date().toISOString(), lastError: 'x', problemShown: 'x', running: null, pending: [] });
  const holder = spawn(process.execPath, [join(FAKES, 'slow-holder.mjs'), p.root, '6000'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  killLater.push(holder.pid);
  const holderExit = new Promise((r) => holder.on('exit', r)); // listen now: with the fix the hooks wait the holder out
  let out = '';
  holder.stdout.on('data', (c) => { out += c; });
  await waitFor(() => out.includes('HOLDING'), 10000);
  const env = { ...process.env, WYBE_CONNECT_HOME: p.root };
  const hooks = [];
  for (let i = 0; i < 4; i++) {
    hooks.push(new Promise((resolve) => {
      const c = spawn(process.execPath, [join(PKG, 'hooks', 'flush.js')], { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => resolve({ code, err }));
      c.stdin.end(JSON.stringify({ session_id: `h${i}`, transcript_path: transcript(100 + i), cwd: 'C:\\work', hook_event_name: 'Stop' }));
    }));
  }
  const hookResults = await Promise.all(hooks);
  const hooksDoneAt = D.loadState(p).pending.map((x) => x.transcriptPath);
  await holderExit;
  const final = D.loadState(p).pending.map((x) => x.transcriptPath);
  const notes = [0, 1, 2, 3].map((i) => transcript(100 + i));
  console.log(`holder: ${out.trim().replace(/\n/g, ' | ')}; hooks: ${JSON.stringify(hookResults.map((h) => h.code))}; noted while the holder still held its lock: ${notes.filter((t) => hooksDoneAt.includes(t)).length}/4; after the holder wrote: ${notes.filter((t) => final.includes(t)).length}/4, holder entry ${final.some((t) => t.includes('holder'))}`);
  assert.ok(notes.every((t) => final.includes(t)), 'the hooks noted their transcripts inside the live holder\'s critical section, and its late write erased them');
});
