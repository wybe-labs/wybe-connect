// The background distil and its delivery (lib/distil.js), through the packaged copy so the run's
// MCP server is the real packages/claude-code/bin/mcp-proxy.js. The headless run is always
// test/fixtures/fake-distil-claude.mjs, never the real claude: maybeRun gets a recorder for
// spawnImpl, and runWatchdog gets an explicit `resolve`. The node is an in-process HTTP fake on
// 127.0.0.1, or the closed port 127.0.0.1:9.
// The first red tests here were the review findings on the earlier delivery build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// No test here may look at a real Claude Code home (an import lists its transcripts).
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wybe-connect-no-home-'));

const PKG = join(import.meta.dirname, '..', 'packages', 'claude-code');
const lib = (f) => import(pathToFileURL(join(PKG, 'lib', f)).href);
const D = await lib('distil.js');
const { paths, saveCredentials, writeJsonPrivate } = await lib('home.js');
const { readRecords } = await lib('ledger.js');
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-distil-claude.mjs');
const resolveFake = () => ({ cmd: process.execPath, pre: [FAKE] });

const MIN = 60 * 1000;
const H = 60 * MIN;
const DOWN = 'http://127.0.0.1:9/mcp';
const fakeTok = () => ['wat', 'x'.repeat(40)].join('_');
const creds = (endpoint) => ({ nodeUrl: 'https://demo.example.test', resource: endpoint, mcpEndpoint: endpoint, issuer: 'https://auth.example.test', tokenEndpoint: 'https://auth.example.test/oauth/token', clientId: 'c1', accessToken: fakeTok(), refreshToken: null, expiresAt: null, scopes: ['remember'] });
const recorder = () => { const spawns = []; return { spawns, spawnImpl: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { pid: 4242, on() {}, unref() {} }; } }; };

function sandbox(n = 3) {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-distil-'));
  const p = paths(join(root, 'home'));
  const dir = join(root, 'projects', 'C--work-demo');
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < n; i++) {
    const f = join(dir, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}.jsonl`);
    writeFileSync(f, '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');
    files.push(f);
  }
  return { root, p, files };
}

/**
 * An MCP node over real HTTP. `answers[i]` is the reply to the i-th remember: 'ok', a status code
 * (NOT stored), 'toolError' (refused, NOT stored) or { delayMs } (stored at once, answered late). With `dedupe` it is the node's idempotency store:
 * a repeat of an idempotency_key on the connection stores nothing and replays the WHOLE first
 * answer (import_done included). `sends` lists every remember it saw. With `strict` it checks the
 * arguments as the node's remember schema does and refuses the whole call (a tool error) on any mismatch.
 */
const NODE_CATEGORIES = ['fact', 'preference', 'pattern', 'entity', 'insight', 'relation'];
// The node's z.uuid() (zod 4): a version digit 1-8 and a variant digit 8, 9, a or b, or the nil or max id.
const UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const nodeSchemaError = (args) => {
  const items = args.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) return 'items';
  for (const it of items) {
    if (typeof it.content !== 'string' || it.content.length < 1 || it.content.length > 4000) return 'content';
    if (it.category !== undefined && !NODE_CATEGORIES.includes(it.category)) return `category: ${it.category}`;
    if (it.subject !== undefined && (typeof it.subject !== 'string' || it.subject.length < 1 || it.subject.length > 200)) return 'subject';
  }
  if (args.answers !== undefined && (!Array.isArray(args.answers) || args.answers.length > 10 || !args.answers.every((a) => UUID.test(a)))) return 'answers';
  if (args.import_of !== undefined && (typeof args.import_of !== 'string' || args.import_of.length < 1 || args.import_of.length > 64)) return 'import_of';
  return null;
};
async function httpNode({ answers = [], dedupe = false, importDone = true, strict = false } = {}) {
  let n = 0;
  const stored = [];
  const sends = [];
  const first = new Map();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      const json = (o, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remember', inputSchema: { type: 'object' } }, { name: 'pending_questions', inputSchema: { type: 'object' } }] } });
      if (msg.method !== 'tools/call') { res.writeHead(200); return res.end(); }
      const args = msg.params?.arguments ?? {};
      if (msg.params?.name !== 'remember') return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, open_questions: [] }) }] } });
      sends.push(args);
      const a = answers[n++] ?? 'ok';
      if (typeof a === 'number') { res.writeHead(a); return res.end('upstream error'); }
      if (a === 'toolError') return json({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Invalid arguments: items[0].content: too long' }] } });
      const invalid = strict ? nodeSchemaError(args) : null;
      if (invalid) return json({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `MCP error -32602: Input validation error: ${invalid}` }] } });
      const key = dedupe ? args.idempotency_key : undefined;
      let answer = key !== undefined ? first.get(key) : undefined;
      if (!answer) {
        for (const it of args.items ?? []) stored.push(it.content);
        answer = { ok: true, stored: (args.items ?? []).length, answered: 0, open_questions: [], ...(args.import_of && importDone ? { import_done: true } : {}) };
        if (key !== undefined) first.set(key, answer);
      }
      const reply = () => json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(answer) }] } });
      if (a?.delayMs) setTimeout(reply, a.delayMs); else reply();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, stored, sends, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/** One scheduler tick plus the watchdog it would start, this process playing the watchdog. */
async function cycle(p, { now, env = {}, timeoutMs, alive } = {}) {
  const rec = recorder();
  const plan = D.maybeRun({ paths: p, env: {}, now, ...(alive ? { alive } : {}), spawnImpl: rec.spawnImpl });
  if (!plan) return { plan: null };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const outcome = await D.runWatchdog(plan.planFile, { paths: p, now: () => now, resolve: resolveFake, ...(timeoutMs ? { timeoutMs } : {}) });
    return { plan, outcome, spawns: rec.spawns };
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const note = (p, files, at) => files.forEach((f, i) => D.noteSession(p, { transcriptPath: f, sessionId: `s${i}`, cwd: 'C:\\work', now: at }));
const pendingPaths = (p) => D.loadState(p).pending.map((x) => x.path);
const fakeRuns = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0);

// ------------------------------------------------------------------ success only on the node's ack
test('node unreachable and the run never finished: the transcripts stay pending, nothing counts as delivered', async () => {
  const { p, files } = sandbox();
  saveCredentials(creds(DOWN), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const r = await cycle(p, { now: T, env: { FAKE_DONE: '0' } });
  assert.equal(r.plan.mode, 'ongoing');
  assert.equal(r.outcome.ok, false);
  const s = D.loadState(p);
  assert.deepEqual(pendingPaths(p).sort(), [...files].sort(), 'all 3 transcripts are pending again');
  assert.equal(s.lastSuccessAt, null);
  assert.ok(s.lastFailureAt);
  assert.equal(s.outbox, null);
  assert.equal(s.running, null);
});

test('node unreachable but the run finished: the facts wait in the outbox, and only the node\'s acks make it a success', async () => {
  const { root, p, files } = sandbox();
  saveCredentials(creds(DOWN), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const log = join(root, 'fake.log');
  const r1 = await cycle(p, { now: T, env: { FAKE_CALLS: '2', FAKE_LOG: log } });
  assert.equal(r1.outcome.ok, false);
  assert.equal(r1.outcome.class, 'node-unreachable');
  let s = D.loadState(p);
  assert.ok(s.outbox, 'the distilled facts are kept for delivery');
  assert.equal(s.lastSuccessAt, null);
  assert.ok(s.lastFailureAt);
  // The run's MCP server offered remember although the node was down.
  assert.ok(JSON.parse(readFileSync(log, 'utf8').trim()).tools.includes('remember'));

  // Within the back-off nothing starts; after it, the outbox is delivered without running claude again.
  assert.equal(D.maybeRun({ paths: p, env: {}, now: T + 10 * MIN, spawnImpl: recorder().spawnImpl }), null);
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const r2 = await cycle(p, { now: T + 31 * MIN, env: { FAKE_LOG: log } });
  node.close();
  assert.equal(r2.plan.mode, 'deliver');
  assert.equal(r2.outcome.ok, true);
  assert.deepEqual(node.stored, ['Fact 1 of 2.', 'Fact 2 of 2.']);
  assert.equal(fakeRuns(log), 1, 'claude ran once');
  s = D.loadState(p);
  assert.equal(s.outbox, null);
  assert.ok(s.lastSuccessAt);
  assert.deepEqual(s.pending, []);
});

test('signed out after the hooks noted: no run starts and nothing is dropped', () => {
  const { p, files } = sandbox();
  saveCredentials(creds(DOWN), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  unlinkSync(p.credentials);
  assert.equal(D.maybeRun({ paths: p, env: {}, now: T, spawnImpl: recorder().spawnImpl }), null);
  assert.equal(D.pendingView(p).length, 3);
});

test('signed out between the distil and the delivery: the outbox is kept and the error says signed out', async () => {
  const { p, files } = sandbox();
  saveCredentials(creds(DOWN), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const rec = recorder();
  const plan = D.maybeRun({ paths: p, env: {}, now: T, spawnImpl: rec.spawnImpl });
  // the run itself needs no grant: it only queues
  const out = await D.runWatchdog(plan.planFile, { paths: p, now: () => T, resolve: () => { unlinkSync(p.credentials); return resolveFake(); } });
  assert.equal(out.ok, false);
  assert.equal(out.class, 'signed-out');
  assert.ok(D.loadState(p).outbox);
});

test('an empty outbox with exit 0 is a failure, never a success', async () => {
  const { p, files } = sandbox();
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const r = await cycle(p, { now: T, env: { FAKE_CALLS: '0', FAKE_DONE: '0' } });
  node.close();
  assert.equal(r.outcome.ok, false);
  assert.equal(r.outcome.class, 'distil-failed');
  assert.equal(pendingPaths(p).length, 3);
  assert.equal(D.loadState(p).lastSuccessAt, null);
});

test('distil_done with nothing to send is a success: nothing durable, and the transcripts are done', async () => {
  const { p, files } = sandbox();
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const r = await cycle(p, { now: T, env: { FAKE_CALLS: '0' } });
  node.close();
  assert.equal(r.outcome.ok, true);
  assert.equal(node.sends.length, 0);
  const s = D.loadState(p);
  assert.deepEqual(s.pending, []);
  assert.ok(s.lastSuccessAt);
  for (const f of files) assert.equal(D.markOf(s, 'https://demo.example.test', f), 3, 'the next run starts after line 3');
});

test('a transcript that grew after its run is distilled again from where the last run stopped', async () => {
  const { root, p, files } = sandbox(1);
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  await cycle(p, { now: T });
  appendFileSync(files[0], '{"type":"user"}\n{"type":"assistant"}\n');
  note(p, files, T + 1 * H);
  const log = join(root, 'fake.log');
  const r = await cycle(p, { now: T + 7 * H, env: { FAKE_LOG: log } });
  node.close();
  assert.equal(r.outcome.ok, true);
  assert.deepEqual(r.plan.transcripts.map((t) => [t.fromLine, t.toLine]), [[3, 5]]);
});

// ------------------------------------------------------------------ exactly once
test('one HTTP 502 re-sends only the lost call; the node holds each fact once and claude ran once', async () => {
  const { root, p, files } = sandbox();
  const node = await httpNode({ answers: ['ok', 502, 'ok', 'ok', 'ok'] });
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const log = join(root, 'fake.log');
  const r1 = await cycle(p, { now: T, env: { FAKE_CALLS: '3', FAKE_LOG: log } });
  assert.equal(r1.outcome.ok, false);
  const r2 = await cycle(p, { now: T + 31 * MIN, env: { FAKE_LOG: log } });
  node.close();
  assert.equal(r2.outcome.ok, true);
  const counts = {};
  for (const t of node.stored) counts[t] = (counts[t] ?? 0) + 1;
  assert.deepEqual(counts, { 'Fact 1 of 3.': 1, 'Fact 2 of 3.': 1, 'Fact 3 of 3.': 1 });
  assert.equal(fakeRuns(log), 1);
});

test('a node that answers late but within the delivery timeout is acknowledged, not re-sent', async () => {
  assert.ok(D.DELIVERY_TIMEOUT_MS >= 60_000, 'the delivery waits a minute, not 15 s');
  const { p, files } = sandbox();
  const node = await httpNode({ answers: [{ delayMs: 1500 }] });
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const r = await cycle(p, { now: T, timeoutMs: 5000 });
  node.close();
  assert.equal(r.outcome.ok, true);
  assert.equal(node.sends.length, 1);
});

test('an answer lost past the timeout is re-sent with the same idempotency key, which the node keeps once', async () => {
  const { p, files } = sandbox();
  const node = await httpNode({ answers: [{ delayMs: 1500 }], dedupe: true });
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const r1 = await cycle(p, { now: T, timeoutMs: 500 });
  assert.equal(r1.outcome.ok, false);
  await new Promise((r) => setTimeout(r, 1600)); // let the late answer go
  const r2 = await cycle(p, { now: T + 31 * MIN, timeoutMs: 5000 });
  node.close();
  assert.equal(r2.outcome.ok, true);
  assert.equal(node.sends.length, 2);
  assert.match(node.sends[0].idempotency_key, /^wc1-[0-9a-f]{64}$/, 'within the node\'s 1-200 characters');
  assert.equal(node.sends[0].idempotency_key, node.sends[1].idempotency_key);
  assert.deepEqual(node.stored, ['Fact 1 of 1.']);
});

test('the node\'s idempotency store: an import whose answer was lost is confirmed by the replayed first answer, stored once', async () => {
  const { p, files } = sandbox();
  const node = await httpNode({ answers: [{ delayMs: 1500 }], dedupe: true });
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files.slice(0, 1), T - MIN);
  const at = '2026-10-21T10:00:00.000Z';
  D.requestImport(p, at);
  const r1 = await cycle(p, { now: T, timeoutMs: 500 });
  assert.equal(r1.outcome.ok, false);
  await new Promise((r) => setTimeout(r, 1600));
  const r2 = await cycle(p, { now: T + 31 * MIN, timeoutMs: 5000 });
  node.close();
  assert.equal(r2.outcome.ok, true);
  assert.equal(r2.outcome.importDone, true);
  assert.deepEqual(node.stored, ['Fact 1 of 1.']);
  const s = D.loadState(p);
  assert.equal(s.importHandled, at);
  assert.equal(s.lastError, null, 'no "import not confirmed" notice');
});

test('a key is never reused for new content: a run redone after a failed distil gets new keys, and run ids carry 128 random bits', async () => {
  const { p, files } = sandbox();
  const node = await httpNode({ dedupe: true });
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const r1 = await cycle(p, { now: T, env: { FAKE_DONE: '0' } }); // spooled call 1, never finished: nothing sent
  assert.equal(r1.outcome.ok, false);
  const r2 = await cycle(p, { now: T + 31 * MIN });
  node.close();
  assert.equal(r2.outcome.ok, true);
  assert.notEqual(r1.plan.runId, r2.plan.runId);
  assert.match(r2.plan.runId, /-[0-9a-f]{32}$/, 'the run id ends in 16 random bytes');
  assert.equal(node.sends.length, 1);
  assert.deepEqual(node.stored, ['Fact 1 of 1.'], 'the redone run was stored, not replayed away');
});

test('each outbox record has its own key, and the key is what goes to the node', async () => {
  const { p, files } = sandbox();
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const r = await cycle(p, { now: T, env: { FAKE_CALLS: '3' } });
  node.close();
  const keys = node.sends.map((s) => s.idempotency_key);
  assert.equal(new Set(keys).size, 3);
  assert.equal(r.outcome.ok, true);
});

// ------------------------------------------------------------------ bounded, never a silent drop
test('with pending full, a failed run\'s transcripts all come back and the sessions noted during the run wait on disk', async () => {
  const { p, files } = sandbox(D.MAX_RUN_TRANSCRIPTS);
  saveCredentials(creds(DOWN), p);
  const T = Date.now();
  const old = T - 7 * H;
  const filler = Array.from({ length: D.MAX_PENDING - files.length }, (_, i) => `C:\\Users\\person\\.claude\\projects\\C--x\\10000000-0000-4000-8000-${String(i).padStart(12, '0')}.jsonl`);
  // the real files are the oldest, so they are the ones the run takes
  const pending = [...files.map((f, i) => ({ path: f, sessionId: null, cwd: null, notedAt: new Date(old + i).toISOString() })), ...filler.map((f, i) => ({ path: f, sessionId: null, cwd: null, notedAt: new Date(old + 1000 + i).toISOString() }))];
  writeJsonPrivate(D.distilPaths(p).state, { version: 2, pending });
  const rec = recorder();
  const plan = D.maybeRun({ paths: p, env: {}, now: T, spawnImpl: rec.spawnImpl });
  assert.equal(plan.transcripts.length, D.MAX_RUN_TRANSCRIPTS);
  const during = Array.from({ length: 40 }, (_, i) => `C:\\Users\\person\\.claude\\projects\\C--x\\20000000-0000-4000-8000-${String(i).padStart(12, '0')}.jsonl`);
  for (const f of during) D.noteSession(p, { transcriptPath: f, now: T + 1000 });
  const saved = process.env.FAKE_DONE;
  process.env.FAKE_DONE = '0';
  const outcome = await D.runWatchdog(plan.planFile, { paths: p, now: () => T + 20 * MIN, resolve: resolveFake });
  if (saved === undefined) delete process.env.FAKE_DONE; else process.env.FAKE_DONE = saved;
  assert.equal(outcome.ok, false);
  const s = D.loadState(p);
  const kept = new Set(s.pending.map((x) => x.path));
  assert.equal(files.filter((f) => kept.has(f)).length, files.length, 'every transcript of the failed run is pending again');
  assert.ok(s.pending.length <= D.MAX_PENDING, 'the pending list stays within its bound');
  const all = new Set(D.pendingView(p).map((x) => x.path));
  assert.equal(all.size, D.MAX_PENDING + during.length, 'nothing was dropped: the overflow waits as note files');
  for (const f of during) assert.ok(all.has(f));
});

test('past the note-file cap a note is dropped with a count, and SessionStart tells it once', () => {
  const { p } = sandbox(0);
  saveCredentials(creds(DOWN), p);
  const T = Date.now();
  const mk = (i) => `C:\\Users\\person\\.claude\\projects\\C--x\\30000000-0000-4000-8000-${String(i).padStart(12, '0')}.jsonl`;
  assert.deepEqual(D.noteSession(p, { transcriptPath: mk(1), now: T, maxNoteFiles: 2 }), { noted: true });
  assert.deepEqual(D.noteSession(p, { transcriptPath: mk(2), now: T, maxNoteFiles: 2 }), { noted: true });
  assert.deepEqual(D.noteSession(p, { transcriptPath: mk(1), now: T, maxNoteFiles: 2 }), { noted: true }, 'a re-note of a waiting session is no new file');
  assert.deepEqual(D.noteSession(p, { transcriptPath: mk(3), now: T, maxNoteFiles: 2 }), { dropped: true });
  const n1 = D.distilNotice(p, { now: T });
  assert.match(n1, /1 session/);
  assert.equal(D.distilNotice(p, { now: T + MIN }), null, 'told once');
});

// ------------------------------------------------------------------ a torn line never counts
test('a torn outbox line fails the distil even when distil_done was written', () => {
  const { p } = sandbox(0);
  const runId = 'r-torn';
  D.spoolRemember(p, runId, { items: [{ content: 'A.' }] });
  D.spoolRemember(p, runId, { items: [{ content: 'B.' }] });
  D.spoolDone(p, runId);
  const file = D.distilPaths(p).outbox(runId);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines[1] = lines[1].replace('B.', 'C.'); // altered: its checksum no longer matches
  writeFileSync(file, lines.join('\n'));
  const v = D.outboxVerdict(p, { runId, mode: 'ongoing' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unreadable/);
});

test('a torn ack line means that call is re-sent, never that the run succeeded', async () => {
  const { p } = sandbox(0);
  const node = await httpNode({ dedupe: true });
  saveCredentials(creds(node.url), p);
  const runId = 'r-acks';
  D.spoolRemember(p, runId, { items: [{ content: 'A.' }] });
  D.spoolRemember(p, runId, { items: [{ content: 'B.' }] });
  D.spoolDone(p, runId);
  const first = await D.deliver(p, { runId, mode: 'ongoing' }, {});
  assert.equal(first.ok, true);
  appendFileSync(D.distilPaths(p).acks(runId), '{"seq":3,"ok":tr');
  const acksFile = D.distilPaths(p).acks(runId);
  const lines = readFileSync(acksFile, 'utf8').split('\n');
  lines[1] = lines[1].slice(0, -3) + 'zzz'; // the ack for B no longer checks out
  writeFileSync(acksFile, lines.join('\n'));
  assert.equal(readRecords(acksFile).torn, 2);
  const again = await D.deliver(p, { runId, mode: 'ongoing' }, {});
  node.close();
  assert.equal(again.ok, true);
  assert.deepEqual(node.sends.map((s) => s.items[0].content), ['A.', 'B.', 'B.'], 'only B went again');
  assert.deepEqual(node.stored, ['A.', 'B.'], 'and the node kept it once by its key');
});

test('an HTTP 200 that is a JSON-RPC error, an isError result, an HTML page, an empty body or ok without stored is never an ack', async () => {
  const bodies = {
    'json-rpc error': (id) => ({ type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'x' } }) }),
    'isError result': (id) => ({ type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'could not store' }] } }) }),
    'html page': () => ({ type: 'text/html', body: '<html>proxy</html>' }),
    'empty body': () => ({ type: 'application/json', body: '' }),
    'ok without stored': (id) => ({ type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }) }),
  };
  for (const [label, make] of Object.entries(bodies)) {
    const { p } = sandbox(0);
    saveCredentials(creds('https://node.example.test/mcp'), p);
    const fetchImpl = async (url, init = {}) => {
      if (init.method === 'DELETE') return new Response('', { status: 200 });
      const msg = JSON.parse(init.body);
      if (msg.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } });
      if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
      const { type, body } = make(msg.id);
      return new Response(body, { status: 200, headers: { 'content-type': type } });
    };
    const runId = `r-${label.replace(/\W+/g, '-')}`;
    D.spoolRemember(p, runId, { items: [{ content: 'A.' }] });
    D.spoolDone(p, runId);
    const out = await D.deliver(p, { runId, mode: 'ongoing' }, { fetchImpl });
    const acks = readRecords(D.distilPaths(p).acks(runId)).records;
    assert.equal(acks.filter((a) => typeof a.stored === 'number').length, 0, `${label}: no ack written`);
    if (label === 'isError result') {
      // The node answered and refused the call for good: set aside and counted, never an ack.
      assert.equal(out.ok, true, label);
      assert.equal(out.refused, 1, label);
      assert.equal(acks.filter((a) => a.refused === true).length, 1, label);
    } else {
      assert.equal(out.ok, false, label);
      assert.equal(acks.length, 0, label);
    }
  }
});

// ------------------------------------------------------------------ set aside, never a wedge
test('a record the node refuses for good (a tool error) is set aside and counted, told once as refused, and later sessions still go', async () => {
  const { p, files } = sandbox(2);
  const node = await httpNode({ answers: ['toolError'] });
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files.slice(0, 1), T - 7 * H);
  const r1 = await cycle(p, { now: T });
  assert.equal(r1.outcome.ok, true, 'the refused record does not hold the outbox');
  assert.equal(r1.outcome.refused, 1);
  let s = D.loadState(p);
  assert.equal(s.outbox, null);
  assert.notEqual(s.lastError?.class, 'node-unreachable', 'the node answered: it is not told as unreachable');
  const n1 = D.distilNotice(p, { now: T + MIN });
  assert.match(n1, /refused 1/);
  assert.doesNotMatch(n1, /could not be reached/);
  assert.equal(D.distilNotice(p, { now: T + 2 * MIN }), null, 'told once');
  note(p, files.slice(1), T + H);
  const r2 = await cycle(p, { now: T + 7 * H });
  node.close();
  assert.equal(r2.plan.mode, 'ongoing', 'the next session is distilled');
  assert.equal(r2.outcome.ok, true);
  assert.deepEqual(node.stored, ['Fact 1 of 1.']);
  assert.equal(node.sends.length, 2, 'the refused record was sent once, never again');
  s = D.loadState(p);
  assert.equal(s.setAside.refused, 1);
});

test('an outbox line damaged after distil_done is set aside; the intact records are still delivered and the pipeline goes on', async () => {
  const { p, files } = sandbox(2);
  saveCredentials(creds(DOWN), p);
  const T = Date.now();
  note(p, files.slice(0, 1), T - 7 * H);
  const r1 = await cycle(p, { now: T, env: { FAKE_CALLS: '2' } });
  assert.equal(r1.outcome.class, 'node-unreachable', 'distilled, kept in the outbox');
  const { outbox } = D.loadState(p);
  const file = D.distilPaths(p).outbox(outbox.runId);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines[0] = lines[0].replace('Fact 1 of 2.', 'Fact 1 of 2!'); // one flipped byte at rest
  writeFileSync(file, lines.join('\n'));
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const r2 = await cycle(p, { now: T + 31 * MIN });
  assert.equal(r2.plan.mode, 'deliver');
  assert.equal(r2.outcome.ok, true);
  assert.equal(r2.outcome.torn, 1);
  assert.deepEqual(node.stored, ['Fact 2 of 2.'], 'the intact record is delivered');
  const kept = readFileSync(D.distilPaths(p).torn(outbox.runId), 'utf8');
  assert.match(kept, /Fact 1 of 2!/, 'the damaged line is kept aside, not deleted');
  const n = D.distilNotice(p, { now: T + 32 * MIN });
  assert.match(n, /damaged/);
  assert.equal(D.distilNotice(p, { now: T + 33 * MIN }), null, 'told once');
  note(p, files.slice(1), T + H);
  const r3 = await cycle(p, { now: T + 8 * H });
  node.close();
  assert.equal(r3.plan.mode, 'ongoing');
  assert.equal(r3.outcome.ok, true);
});

// ------------------------------------------------------------------ an outbox belongs to one node
test('an outbox made for node A is never sent to node B; it is kept, told once, and delivered when A is connected again', async () => {
  const { p, files } = sandbox(1);
  const a = await httpNode({ answers: [502] });
  const b = await httpNode();
  try {
    saveCredentials(creds(a.url), p);
    const T = Date.now();
    note(p, files, T - 7 * H);
    const r1 = await cycle(p, { now: T });
    assert.equal(r1.outcome.class, 'node-unreachable', 'distilled for A, kept in the outbox');
    const runId = r1.plan.runId;
    saveCredentials({ ...creds(b.url), nodeUrl: 'https://node-b.example.invalid' }, p);
    const r2 = await cycle(p, { now: T + 31 * MIN });
    assert.equal(r2.plan, null, 'nothing to do for B: A\'s outbox is not B\'s');
    assert.deepEqual(b.sends, [], 'B received nothing');
    let s = D.loadState(p);
    assert.equal(s.outbox, null);
    assert.deepEqual(s.parked.map((x) => x.runId), [runId], 'kept on this machine for A');
    const n = D.distilNotice(p, { now: T + 32 * MIN });
    assert.match(n, /another colleague/);
    assert.equal(D.distilNotice(p, { now: T + 33 * MIN }), null, 'told once');
    // A delivery started before the switch is refused at the door, too.
    const direct = await D.deliver(p, { runId, mode: 'ongoing', node: 'https://demo.example.test' }, {});
    assert.equal(direct.ok, false);
    assert.equal(direct.class, 'node-changed');
    assert.deepEqual(b.sends, []);
    saveCredentials(creds(a.url), p);
    const r3 = await cycle(p, { now: T + 7 * H });
    assert.equal(r3.plan.mode, 'deliver');
    assert.equal(r3.outcome.ok, true);
    assert.deepEqual(a.stored, ['Fact 1 of 1.'], 'delivered to A once A is connected again');
    s = D.loadState(p);
    assert.deepEqual(s.parked, []);
  } finally {
    a.close();
    b.close();
  }
});

test('the idempotency key is bound to the node: the same run and record give another key on another node', async () => {
  const { p, files } = sandbox(1);
  const a = await httpNode();
  try {
    saveCredentials(creds(a.url), p);
    const T = Date.now();
    note(p, files, T - 7 * H);
    const r = await cycle(p, { now: T });
    assert.equal(r.outcome.ok, true);
    const key = a.sends[0].idempotency_key;
    assert.equal(key, D.recordKey('https://demo.example.test', r.plan.runId, 1));
    assert.notEqual(D.recordKey('https://node-b.example.invalid', r.plan.runId, 1), key);
    assert.match(key, /^wc1-[0-9a-f]{64}$/);
  } finally {
    a.close();
  }
});

// ------------------------------------------------------------------ told once per kind
test('one continuing outage is told once, whatever number of calls each run made', async () => {
  const { p, files } = sandbox();
  const node = await httpNode({ answers: Array(20).fill(502) });
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  let told = 0;
  const r1 = await cycle(p, { now: T, env: { FAKE_CALLS: '2' } });
  assert.equal(r1.outcome.ok, false);
  if (D.distilNotice(p, { now: T })) told += 1;
  for (let k = 1; k <= 2; k++) {
    await cycle(p, { now: T + k * 31 * MIN });
    if (D.distilNotice(p, { now: T + k * 31 * MIN })) told += 1;
  }
  node.close();
  assert.equal(told, 1);
});

// ------------------------------------------------------------------ the run's lifecycle
test('a run whose watchdog died before distil_done gives its transcripts back; one that died after is delivered, not redone', () => {
  const { p, files } = sandbox();
  saveCredentials(creds(DOWN), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const dead = () => false;
  const a = D.maybeRun({ paths: p, env: {}, now: T, alive: dead, spawnImpl: recorder().spawnImpl });
  assert.equal(a.mode, 'ongoing');
  assert.equal(D.loadState(p).pending.length, 0);
  // the watchdog (pid 4242) is gone: the next tick returns the transcripts, and the back-off holds
  assert.equal(D.maybeRun({ paths: p, env: {}, now: T + 3 * MIN, alive: dead, spawnImpl: recorder().spawnImpl }), null);
  let s = D.loadState(p);
  assert.equal(s.running, null);
  assert.equal(s.pending.length, 3);
  assert.equal(s.lastError.class, 'distil-failed');
  // the same, but the run had finished its outbox before the watchdog died
  const b = D.maybeRun({ paths: p, env: {}, now: T + 40 * MIN, alive: dead, spawnImpl: recorder().spawnImpl });
  D.spoolRemember(p, b.runId, { items: [{ content: 'A.' }] });
  D.spoolDone(p, b.runId);
  const c = D.maybeRun({ paths: p, env: {}, now: T + 75 * MIN, alive: dead, spawnImpl: recorder().spawnImpl });
  s = D.loadState(p);
  assert.equal(s.outbox?.runId, b.runId, 'the finished outbox is kept');
  assert.equal(s.pending.length, 0, 'its transcripts are not distilled again');
  assert.equal(c?.mode, 'deliver');
});

test('a live watchdog is never replaced, and a run declared dead cannot bind late (fenced by runId)', async () => {
  const { p, files } = sandbox();
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const a = D.maybeRun({ paths: p, env: {}, now: T, alive: () => true, spawnImpl: recorder().spawnImpl });
  assert.ok(a);
  assert.equal(D.maybeRun({ paths: p, env: {}, now: T + 20 * MIN, alive: () => true, spawnImpl: recorder().spawnImpl }), null, 'a live run is left alone');
  // While the watchdog runs claude, a tick past RUN_DEAD_AFTER_MS (a reused pid) declares it dead
  // and gives the transcripts back. The watchdog then finishes anyway: its result must change nothing.
  const late = await D.runWatchdog(a.planFile, {
    paths: p,
    now: () => T + 50 * MIN,
    resolve: () => {
      assert.equal(D.maybeRun({ paths: p, env: {}, now: T + 46 * MIN, alive: () => true, spawnImpl: recorder().spawnImpl }), null);
      return resolveFake();
    },
  });
  node.close();
  assert.equal(late.outcome, 'superseded');
  assert.equal(node.sends.length, 0, 'nothing was delivered by the superseded watchdog');
  const s = D.loadState(p);
  assert.equal(s.pending.length, 3);
  assert.equal(s.outbox, null);
});

test('the headless run is confined: read-only tools, only the plugin\'s own server, no prompts, and it knows it is a distil run', async () => {
  const { root, p, files } = sandbox();
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const log = join(root, 'fake.log');
  const r = await cycle(p, { now: T, env: { FAKE_LOG: log } });
  node.close();
  const ran = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.equal(ran.flags.tools, 'Read,Glob,Grep');
  assert.equal(ran.flags.strict, true);
  assert.equal(ran.flags.permissionMode, 'dontAsk');
  assert.equal(ran.flags.maxTurns, '40');
  assert.deepEqual(ran.flags.allowedTools.split(',').sort(), ['mcp__wybe__distil_done', 'mcp__wybe__pending_questions', 'mcp__wybe__remember']);
  assert.equal(ran.env.distil, r.plan.runId);
  assert.deepEqual([...ran.tools].sort(), ['distil_done', 'pending_questions', 'remember']);
  assert.equal(ran.flags.settingSources, '', 'none of the person\'s settings files: no hooks, plugins or permission rules of theirs');
  assert.equal(ran.flags.settings, join(D.distilPaths(p).runs, `${r.plan.runId}.settings.json`), 'the rules are a file of the run, so each path is on the command line once');
  const settings = JSON.parse(ran.settingsFile);
  assert.equal(settings.disableAllHooks, true);
  assert.deepEqual([...settings.permissions.allow].sort(), files.flatMap(fileRules).sort(), 'it may read, glob and grep exactly the noted transcripts');
  assert.equal(existsSync(ran.flags.settings), false, 'the file goes when the run ends');
  assert.equal(ran.cwd, join(p.state, 'distil'), 'it runs in the distil\'s own folder, never in a project of the person');
});

// The absolute form of a path in a permission rule: POSIX, `//` from the root, a drive as /c/.
const ruleAbs = (path) => `/${path.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/')}`;
// Read, Glob and Grep each get the same path-scoped rule: a file, or a folder and what lies in it.
const fileRules = (path) => ['Read', 'Glob', 'Grep'].map((tool) => `${tool}(${ruleAbs(path)})`);
const folderRules = (path) => [...fileRules(path), ...['Read', 'Glob', 'Grep'].map((tool) => `${tool}(${ruleAbs(path)}/**)`)];

test('the run\'s read rules are path-scoped per transcript, in Claude Code\'s POSIX form on Windows and elsewhere', () => {
  const plan = {
    runId: 'r-w', mode: 'ongoing', connection: null,
    transcripts: [
      { path: 'C:\\Users\\Ola Nordmann\\.claude\\projects\\C--work-demo\\a.jsonl', fromLine: 0, toLine: 3 },
      { path: 'D:\\claude [work]\\projects\\x\\b*?.jsonl', fromLine: 1, toLine: 2 },
      { path: '/home/ola/.claude/projects/-home-ola-demo/c.jsonl', fromLine: 0, toLine: 1 },
    ],
  };
  const args = D.claudeArgs(plan, { root: '/h', settingsFile: '/h/run.settings.json' });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--settings') + 1], '/h/run.settings.json');
  const settings = D.claudeSettings(plan);
  assert.equal(settings.disableAllHooks, true);
  assert.deepEqual(settings.permissions.allow, [
    'Read(//c/Users/Ola Nordmann/.claude/projects/C--work-demo/a.jsonl)',
    'Glob(//c/Users/Ola Nordmann/.claude/projects/C--work-demo/a.jsonl)',
    'Grep(//c/Users/Ola Nordmann/.claude/projects/C--work-demo/a.jsonl)',
    'Read(//d/claude \\[work\\]/projects/x/b\\*\\?.jsonl)',
    'Glob(//d/claude \\[work\\]/projects/x/b\\*\\?.jsonl)',
    'Grep(//d/claude \\[work\\]/projects/x/b\\*\\?.jsonl)',
    'Read(//home/ola/.claude/projects/-home-ola-demo/c.jsonl)',
    'Glob(//home/ola/.claude/projects/-home-ola-demo/c.jsonl)',
    'Grep(//home/ola/.claude/projects/-home-ola-demo/c.jsonl)',
  ]);
  const prompt = args[args.indexOf('-p') + 1];
  assert.match(prompt, /Grep a listed transcript by its own path/, 'the run is told how it may search a long range');
  assert.ok(!settings.permissions.allow.some((r) => /^(Read|Glob|Grep)$/.test(r)), 'never a rule for every path');
  assert.deepEqual(args[args.indexOf('--allowedTools') + 1].split(',').sort(), ['mcp__wybe__distil_done', 'mcp__wybe__pending_questions', 'mcp__wybe__remember']);
});

test('an import may also read the Claude home\'s CLAUDE.md and, of the projects in its transcripts, their CLAUDE.md and auto memory, nothing more', () => {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-import-reads-'));
  const home = join(root, 'claude-home');
  const project = join(root, 'harbour');
  const folder = join(home, 'projects', 'C--harbour');
  const other = join(home, 'projects', 'C--other');
  mkdirSync(join(folder, 'memory'), { recursive: true });
  mkdirSync(join(other, 'memory'), { recursive: true });
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, 'CLAUDE.md'), '# harbour\n');
  writeFileSync(join(project, '.claude', 'CLAUDE.md'), '# harbour, local\n');
  writeFileSync(join(home, 'CLAUDE.md'), '# me\n');
  const t = join(folder, '00000000-0000-4000-8000-0000000000aa.jsonl');
  writeFileSync(t, `${JSON.stringify({ type: 'user', cwd: project, message: { role: 'user', content: 'hi' } })}\n`);
  const plan = { runId: 'r-i', mode: 'import', importOf: '2026-10-21T10:00:00.000Z', connection: null, claudeHome: home, transcripts: [{ path: t, sessionId: 's', cwd: null, fromLine: 0, toLine: 1 }] };
  const args = D.claudeArgs(plan, { root: '/h', settingsFile: '/h/run.settings.json' });
  const allow = D.claudeSettings(plan).permissions.allow;
  assert.deepEqual([...allow].sort(), [
    ...fileRules(t),
    ...fileRules(join(home, 'CLAUDE.md')),
    ...fileRules(join(project, 'CLAUDE.md')),
    ...fileRules(join(project, '.claude', 'CLAUDE.md')),
    ...folderRules(join(folder, 'memory')),
  ].sort());
  assert.ok(!allow.some((r) => /^(Glob|Grep)\(.*\/projects(\/\*\*)?\)$/.test(r)), 'never the projects folder itself');
  assert.ok(!allow.some((r) => r.includes('C--other')), 'another project\'s memory is not in this import');
  const prompt = args[args.indexOf('-p') + 1];
  assert.ok(prompt.includes(join(folder, 'memory')), 'the prompt names the memory folder it may read');
  assert.ok(prompt.includes(join(project, 'CLAUDE.md')), 'the prompt names the project\'s CLAUDE.md');
});

test('the run\'s whole command line stays within the Windows limit at the run\'s caps', () => {
  const long = (i) => `C:\\Users\\${'p'.repeat(30)}\\.claude\\projects\\C--${'w'.repeat(120)}-${i}\\${'0'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}.jsonl`;
  const transcripts = [];
  let chars = 0;
  for (let i = 0; transcripts.length < D.MAX_RUN_TRANSCRIPTS && chars + long(i).length <= D.MAX_RUN_PATH_CHARS; i++) {
    transcripts.push({ path: long(i), cwd: `C:\\${'w'.repeat(120)}-${i}`, fromLine: 1000, toLine: 99999 });
    chars += long(i).length;
  }
  const plan = { runId: 'r-max', mode: 'import', importOf: '2026-10-21T10:00:00.000Z', connection: 'node', claudeHome: `C:\\Users\\${'p'.repeat(30)}\\.claude`, transcripts };
  const args = D.claudeArgs(plan, { root: `C:\\Users\\${'p'.repeat(30)}\\.wybe-connect`, settingsFile: `C:\\Users\\${'p'.repeat(30)}\\.wybe-connect\\connections\\node\\distil\\runs\\${'r'.repeat(80)}.settings.json`, pluginRoot: `C:\\Users\\${'p'.repeat(30)}\\.claude\\plugins\\cache\\wybe-connect\\wybe-connect\\0.3.0` });
  const line = [process.execPath, ...args].map((a) => `"${a.replace(/(\\*)"/g, '$1$1\\"')}"`).join(' ');
  assert.ok(line.length < 32767, `${line.length} chars`);
});

test('the scheduler: nothing inside a distil run, nothing without remember, 6 h between ongoing runs', async () => {
  const { p, files } = sandbox();
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files.slice(0, 1), T - 7 * H);
  assert.equal(D.maybeRun({ paths: p, env: { WYBE_CONNECT_DISTIL: 'r1' }, now: T, spawnImpl: recorder().spawnImpl }), null);
  const r = await cycle(p, { now: T });
  assert.equal(r.outcome.ok, true);
  note(p, files.slice(1, 2), T + MIN);
  assert.equal(D.maybeRun({ paths: p, env: {}, now: T + 2 * H, spawnImpl: recorder().spawnImpl }), null, 'within 6 h of a success');
  const later = await cycle(p, { now: T + 6 * H + MIN });
  node.close();
  assert.equal(later.outcome.ok, true);
  saveCredentials({ ...creds(node.url), scopes: ['sessions:light'] }, p);
  assert.equal(D.noteSession(p, { transcriptPath: files[2], now: T }), null, 'a grant without remember notes nothing');
});

// ------------------------------------------------------------------ Import
test('Import: a request runs once, sends import_of on its last call, and counts only on the node\'s import_done', async () => {
  const { root, p, files } = sandbox();
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files.slice(0, 1), T - MIN);
  const at = '2026-10-21T10:00:00.000Z';
  assert.equal(D.requestImport(p, 'yesterday'), false, 'a requested_at that is not an ISO timestamp is dropped');
  assert.equal(D.requestImport(p, at), true);
  const log = join(root, 'fake.log');
  const r = await cycle(p, { now: T, env: { FAKE_CALLS: '2', FAKE_LOG: log } });
  assert.equal(r.plan.mode, 'import');
  assert.equal(r.outcome.ok, true);
  assert.deepEqual(node.sends.map((s) => s.import_of ?? null), [null, at]);
  assert.equal(D.loadState(p).importHandled, at);
  assert.equal(D.requestImport(p, at), false, 'the same request is not run twice');
  assert.equal(D.maybeRun({ paths: p, env: {}, now: T + MIN, spawnImpl: recorder().spawnImpl }), null);
  node.close();
});

test('Import: facts in the words a model picks (category, empty subject, a non-id answer) reach a node that checks its schema, and the import is confirmed', async () => {
  const { root, p, files } = sandbox();
  const node = await httpNode({ strict: true });
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files.slice(0, 1), T - MIN);
  const at = '2026-10-21T10:00:00.000Z';
  D.requestImport(p, at);
  const log = join(root, 'fake.log');
  const r = await cycle(p, { now: T, env: { FAKE_CALLS: '1', FAKE_LOG: log, FAKE_ITEM: JSON.stringify({ category: 'ways of working', subject: '' }), FAKE_ANSWERS: JSON.stringify(['q-1']) } });
  node.close();
  assert.equal(r.outcome.ok, true);
  assert.equal(r.outcome.refused, 0, 'the node refused nothing');
  assert.equal(r.outcome.importDone, true, 'the node confirmed the import');
  assert.deepEqual(node.stored, ['Fact 1 of 1.']);
  assert.equal(node.sends[0].import_of, at);
  assert.equal(D.loadState(p).lastError, null);
});

test('Import: an answer shaped like an id but with a version or variant digit the node does not take is left out, and the import is confirmed', async () => {
  const { p, files } = sandbox();
  const node = await httpNode({ strict: true });
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files.slice(0, 1), T - MIN);
  const at = '2026-10-21T10:00:00.000Z';
  D.requestImport(p, at);
  const r = await cycle(p, { now: T, env: { FAKE_CALLS: '1', FAKE_ANSWERS: JSON.stringify(['12345678-1234-1234-1234-123456789abc', '12345678-1234-4234-7234-123456789abc']) } });
  node.close();
  assert.equal(r.outcome.refused, 0, 'the node refused nothing');
  assert.equal(r.outcome.importDone, true, 'the node confirmed the import');
  assert.equal(node.sends[0].answers, undefined, 'neither is a question id the node takes');
  assert.equal(D.loadState(p).lastError, null);
});

test('remember keeps exactly the answers the node takes as question ids', async () => {
  const { cleanRememberArgs } = await lib('mcp-proxy.js');
  const ok = ['0b6f3c6e-6a3e-4f1a-9c3e-2b1d4e5f6a7b', '0B6F3C6E-6A3E-1F1A-AC3E-2B1D4E5F6A7B', '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
  const not = ['12345678-1234-1234-1234-123456789abc', '12345678-1234-0234-8234-123456789abc', '12345678-1234-9234-8234-123456789abc', '12345678-1234-4234-c234-123456789abc', 'q-1'];
  for (const a of [...ok, ...not]) assert.equal(UUID.test(a), ok.includes(a), `the fake node agrees on ${a}`);
  const { args } = cleanRememberArgs({ items: [{ content: 'A fact.' }], answers: [...not, ...ok] });
  assert.deepEqual(args.answers, ok);
});

test('the distil run\'s remember offers exactly the node\'s categories', async () => {
  const { DISTIL_TOOLS } = await lib('mcp-proxy.js');
  const remember = DISTIL_TOOLS.find((t) => t.name === 'remember');
  assert.deepEqual(remember.inputSchema.properties.items.items.properties.category.enum, NODE_CATEGORIES);
});

test('Import: a run that sent no import_of is a failed distil, retried after the back-off', async () => {
  const { p, files } = sandbox();
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files.slice(0, 1), T - MIN);
  D.requestImport(p, '2026-10-21T10:00:00.000Z');
  const r = await cycle(p, { now: T, env: { FAKE_CALLS: '0' } });
  node.close();
  assert.equal(r.outcome.ok, false);
  assert.equal(r.outcome.class, 'distil-failed');
  assert.equal(D.loadState(p).importHandled, null);
});

test('the run\'s files are removed once its outbox is delivered', async () => {
  const { p, files } = sandbox();
  const node = await httpNode();
  saveCredentials(creds(node.url), p);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const r = await cycle(p, { now: T });
  node.close();
  assert.equal(r.outcome.ok, true);
  const left = readdirSync(D.distilPaths(p).runs).filter((f) => f.startsWith(r.plan.runId) && !f.endsWith('.log'));
  assert.deepEqual(left, []);
});

// ------------------------------------------------------------------ several connections (lib/connections.js)
const C = await lib('connections.js');
const { readJson, loadCredentials } = await lib('home.js');

/** A fetch that records the bearer of every tools/call it passes on, and can act after one. */
function recordingFetch(after = () => {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const res = await fetch(url, init);
    const msg = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return {}; } })();
    if (msg.method === 'tools/call') {
      calls.push({ url: String(url), auth: init.headers?.authorization });
      after(calls.length);
    }
    return res;
  };
  return { calls, fetchImpl };
}

async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('connections: an outbox made under connection A is delivered with A\'s grant on any session\'s tick, even when B is the default now', async () => {
  const { root, files } = sandbox(1);
  const home = join(root, 'home');
  const tokB = ['wat', 'b'.repeat(40)].join('_');
  const keyA = C.saveConnection(home, { ...creds(DOWN), nodeUrl: 'https://node-a.example.invalid' });
  const pa = C.connectionPaths(home, keyA);
  const T = Date.now();
  note(pa, files, T - 7 * H);
  const r1 = await cycle(pa, { now: T });
  assert.equal(r1.outcome.class, 'node-unreachable');
  assert.ok(D.loadState(pa).outbox, 'A\'s facts wait in A\'s outbox');

  const a = await httpNode();
  const b = await httpNode();
  try {
    saveCredentials({ ...loadCredentials(pa), mcpEndpoint: a.url, resource: a.url }, pa); // A reachable again, same grant
    const keyB = C.saveConnection(home, { ...creds(b.url), nodeUrl: 'https://node-b.example.invalid', accessToken: tokB });
    assert.equal(C.defaultConnection(home), keyB);
    const rec = recorder();
    const plans = D.maybeRunAll(home, { env: {}, now: T + 31 * MIN, spawnImpl: rec.spawnImpl });
    assert.deepEqual(plans.map((x) => x.mode), ['deliver'], 'only A has work: its outbox');
    const plan = readJson(plans[0].planFile);
    assert.equal(plan.connection, keyA);
    const rf = recordingFetch();
    const out = await D.runWatchdog(plans[0].planFile, { paths: D.planPaths(plan, home), now: () => T + 31 * MIN, resolve: resolveFake, fetchImpl: rf.fetchImpl });
    assert.equal(out.ok, true);
    assert.deepEqual(a.stored, ['Fact 1 of 1.']);
    assert.deepEqual(b.sends, []);
    assert.deepEqual(rf.calls.map((c) => c.auth), [`Bearer ${fakeTok()}`]);
    assert.equal(D.loadState(C.connectionPaths(home, keyB)).outbox, null);
  } finally {
    a.close();
    b.close();
  }
});

test('connections: a delivery stops when the grant is replaced while it runs, never writes over the new grant, and the next tick sends the rest with it', async () => {
  const { root, files } = sandbox(1);
  const home = join(root, 'home');
  const node = await httpNode();
  try {
    const key = C.saveConnection(home, creds(node.url));
    const p = C.connectionPaths(home, key);
    const T = Date.now();
    note(p, files, T - 7 * H);
    const newTok = ['wat', 'n'.repeat(40)].join('_');
    // the person signs in again (a new grantId) right after the first record reached the node
    const rf = recordingFetch((n) => { if (n === 1) C.saveConnection(home, { ...creds(node.url), accessToken: newTok }); });
    const plan = D.maybeRun({ paths: p, env: {}, now: T, spawnImpl: recorder().spawnImpl });
    const out = await withEnv({ FAKE_CALLS: '2' }, () => D.runWatchdog(plan.planFile, { paths: p, now: () => T, resolve: resolveFake, fetchImpl: rf.fetchImpl }));
    assert.equal(out.ok, false);
    assert.equal(out.class, 'grant-changed');
    assert.deepEqual(node.stored, ['Fact 1 of 2.']);
    assert.equal(loadCredentials(p).accessToken, newTok, 'the new grant stands');
    const s = D.loadState(p);
    assert.ok(s.outbox, 'the rest waits');
    assert.equal(s.lastFailureAt, null, 'not a failure: no back-off');

    const rf2 = recordingFetch();
    const next = D.maybeRun({ paths: p, env: {}, now: T + MIN, spawnImpl: recorder().spawnImpl });
    assert.equal(next.mode, 'deliver');
    const out2 = await D.runWatchdog(next.planFile, { paths: p, now: () => T + MIN, resolve: resolveFake, fetchImpl: rf2.fetchImpl });
    assert.equal(out2.ok, true);
    assert.deepEqual(node.stored, ['Fact 1 of 2.', 'Fact 2 of 2.'], 'each fact once');
    assert.deepEqual(rf2.calls.map((c) => c.auth), [`Bearer ${newTok}`]);
  } finally {
    node.close();
  }
});

test('connections: a connection removed during its run gets nothing written back', async () => {
  const { root, files } = sandbox(1);
  const home = join(root, 'home');
  const key = C.saveConnection(home, creds(DOWN));
  const p = C.connectionPaths(home, key);
  const T = Date.now();
  note(p, files, T - 7 * H);
  const plan = D.maybeRun({ paths: p, env: {}, now: T, spawnImpl: recorder().spawnImpl });
  await assert.rejects(
    D.runWatchdog(plan.planFile, { paths: p, now: () => T, resolve: () => { C.removeConnection(home, key); return resolveFake(); } }),
    { code: 'ECONNGONE' },
  );
  assert.equal(existsSync(join(home, 'connections', key)), false);
  assert.equal(D.maybeRun({ paths: p, env: {}, now: T + H, spawnImpl: recorder().spawnImpl }), null);
});

test('connections: an import takes only the sessions of its own connection and those never fixed to one', () => {
  const { root, files } = sandbox(3);
  const home = join(root, 'home');
  const key = C.saveConnection(home, creds(DOWN));
  const p = C.connectionPaths(home, key);
  const sid = (f) => f.split(/[\\/]/).pop().slice(0, -'.jsonl'.length);
  writeJsonPrivate(join(home, 'state', 'sessions', `${sid(files[1])}.json`), { connection: 'other.example.invalid', nodeUrl: 'https://other.example.invalid' });
  writeJsonPrivate(join(home, 'state', 'sessions', `${sid(files[2])}.json`), { connection: key, nodeUrl: 'https://demo.example.test' });
  assert.equal(D.requestImport(p, '2026-10-21T10:00:00.000Z'), true);
  const plan = D.maybeRun({ paths: p, env: {}, now: Date.now(), spawnImpl: recorder().spawnImpl, claudeHome: root });
  assert.equal(plan.mode, 'import');
  assert.deepEqual(plan.transcripts.map((t) => t.path).sort(), [files[0], files[2]].sort());
});
