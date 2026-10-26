// A transcript's lines are distilled at most once per node, whatever starts the run: the Stop
// hook, the node's import, a resumed session, or a session resumed long after it was distilled.
// Exactly once per record (the idempotency key) cannot catch a line read twice: a second read is a
// new run with new keys, so the node would store the same essence again. The headless run is
// test/fixtures/line-facts-claude.mjs (never the real claude): one fact per transcript line it is
// told to read, so a fact stored twice is a line distilled twice. The node is an in-process HTTP
// fake on 127.0.0.1 that keeps a key once, as the node does. The Claude Code home is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// No test here may look at a real Claude Code home.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wybe-connect-no-home-'));

const PKG = join(import.meta.dirname, '..', 'packages', 'claude-code');
const lib = (f) => import(pathToFileURL(join(PKG, 'lib', f)).href);
const D = await lib('distil.js');
const { paths, saveCredentials } = await lib('home.js');
const LINE_FACTS = join(import.meta.dirname, 'fixtures', 'line-facts-claude.mjs');
const resolveLineFacts = () => ({ cmd: process.execPath, pre: [LINE_FACTS] });

const MIN = 60 * 1000;
const H = 60 * MIN;
const DAY = 24 * H;
const NODE_A = 'https://node-a.example.invalid';
const NODE_B = 'https://node-b.example.invalid';
const tok = () => ['wat', 'q'.repeat(40)].join('_');
const creds = (endpoint, nodeUrl = NODE_A) => ({ nodeUrl, resource: endpoint, mcpEndpoint: endpoint, issuer: 'https://auth.example.invalid', tokenEndpoint: 'https://auth.example.invalid/oauth/token', clientId: 'c1', accessToken: tok(), refreshToken: null, expiresAt: null, scopes: ['remember'] });
const spawnImpl = () => ({ pid: 4242, on() {}, unref() {} });

/** A person's machine: the plugin's home and a Claude Code home with one project folder. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-once-'));
  const p = paths(join(root, 'wybe-connect'));
  const claudeHome = join(root, 'claude');
  const projects = join(claudeHome, 'projects');
  const dir = join(projects, 'C--work-demo');
  mkdirSync(dir, { recursive: true });
  const transcript = (name, n, first = null) => {
    const f = join(dir, `${name}.jsonl`);
    const lines = Array.from({ length: n }, (_, i) => `{"type":"${i % 2 ? 'assistant' : 'user'}","n":${i + 1}}`);
    if (first) lines[0] = first;
    writeFileSync(f, `${lines.join('\n')}\n`);
    return f;
  };
  return { p, claudeHome, projects, transcript };
}

/** A node that keeps an idempotency_key once per person and confirms the import it asked for. */
async function httpNode() {
  const stored = [];
  const first = new Map();
  let importPending = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      const json = (o, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method !== 'tools/call') { res.writeHead(200); return res.end(); }
      const args = msg.params?.arguments ?? {};
      const text = (o) => json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
      if (msg.params?.name !== 'remember') return text({ ok: true, open_questions: [] });
      let answer = first.get(args.idempotency_key);
      if (!answer) {
        for (const it of args.items ?? []) stored.push(it.content);
        const done = Boolean(args.import_of) && args.import_of === importPending;
        if (done) importPending = null;
        answer = { ok: true, stored: (args.items ?? []).length, answered: 0, open_questions: [], ...(done ? { import_done: true } : {}) };
        first.set(args.idempotency_key, answer);
      }
      text(answer);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, stored, requestImport: (at) => { importPending = at; }, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/** One scheduler tick and the watchdog it would start, this process playing the watchdog. */
async function cycle(m, now) {
  const plan = D.maybeRun({ paths: m.p, env: {}, now, spawnImpl, claudeHome: m.claudeHome });
  if (!plan) return { plan: null };
  const prev = process.env.FAKE_PROJECTS;
  process.env.FAKE_PROJECTS = m.projects;
  try {
    return { plan, outcome: await D.runWatchdog(plan.planFile, { paths: m.p, now: () => now, resolve: resolveLineFacts }) };
  } finally {
    if (prev === undefined) delete process.env.FAKE_PROJECTS; else process.env.FAKE_PROJECTS = prev;
  }
}

const twice = (xs) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
const ranges = (r) => (r.plan?.transcripts ?? []).map((t) => `${t.fromLine + 1}-${t.toLine}`);
const importNow = (m, node, at) => { node.requestImport(at); assert.equal(D.requestImport(m.p, at), true); };

test('first connect: the connect session is distilled by the first run, and the node\'s import does not read it again', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    saveCredentials(creds(node.url), m.p);
    const T = Date.now();
    const connect = m.transcript('11111111-1111-4111-8111-111111111111', 4);
    D.noteSession(m.p, { transcriptPath: connect, sessionId: 's-connect', now: T });
    const r1 = await cycle(m, T);
    assert.equal(r1.plan.mode, 'ongoing');
    importNow(m, node, new Date(T).toISOString());
    const r2 = await cycle(m, T + 5 * MIN);
    assert.equal(r2.plan.mode, 'import');
    assert.equal(r2.outcome.ok, true);
    assert.equal(r2.outcome.importDone, true);
    assert.deepEqual(r2.plan.transcripts.map((t) => t.path), [], 'the import plan leaves out what was distilled');
    assert.deepEqual(twice(node.stored), [], 'every fact once');
    assert.equal(node.stored.filter((f) => f.startsWith('11111111')).length, 4);
  } finally {
    node.close();
  }
});

test('a session the import read is resumed later: the next run reads only its new lines', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    saveCredentials(creds(node.url), m.p);
    const T = Date.now();
    const old = m.transcript('22222222-2222-4222-8222-222222222222', 4); // from before the plugin, never noted
    utimesSync(old, new Date(T - 3 * DAY), new Date(T - 3 * DAY));
    importNow(m, node, new Date(T).toISOString());
    const r1 = await cycle(m, T);
    assert.equal(r1.plan.mode, 'import');
    assert.deepEqual(ranges(r1), ['1-4'], 'the plugin, not the model, lists what the import reads');
    appendFileSync(old, '{"type":"user","n":5}\n{"type":"assistant","n":6}\n');
    D.noteSession(m.p, { transcriptPath: old, sessionId: 's-old', now: T + 7 * DAY });
    const r2 = await cycle(m, T + 7 * DAY);
    assert.deepEqual(ranges(r2), ['5-6']);
    assert.deepEqual(twice(node.stored), [], 'every fact once');
  } finally {
    node.close();
  }
});

test('a session resumed long after it was distilled, with other runs in between, is read only from where it stopped', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    saveCredentials(creds(node.url), m.p);
    const T = Date.now();
    const a = m.transcript('33333333-3333-4333-8333-333333333333', 2);
    D.noteSession(m.p, { transcriptPath: a, now: T });
    await cycle(m, T);
    const b = m.transcript('44444444-4444-4444-8444-444444444444', 2);
    D.noteSession(m.p, { transcriptPath: b, now: T + 91 * DAY });
    await cycle(m, T + 91 * DAY);
    const c = m.transcript('55555555-5555-4555-8555-555555555555', 2);
    D.noteSession(m.p, { transcriptPath: c, now: T + 400 * DAY });
    await cycle(m, T + 400 * DAY);
    appendFileSync(a, '{"type":"user","n":3}\n{"type":"assistant","n":4}\n');
    D.noteSession(m.p, { transcriptPath: a, now: T + 401 * DAY });
    const r = await cycle(m, T + 401 * DAY);
    assert.deepEqual(ranges(r), ['3-4'], 'its mark lasts as long as the transcript does');
    assert.deepEqual(twice(node.stored), [], 'every fact once');
  } finally {
    node.close();
  }
});

test('the import lists the last 30 days only, and never the distil runs\' own sessions', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    saveCredentials(creds(node.url), m.p);
    const T = Date.now();
    const recent = m.transcript('66666666-6666-4666-8666-666666666666', 2);
    const old = m.transcript('77777777-7777-4777-8777-777777777777', 2);
    utimesSync(old, new Date(T - 40 * DAY), new Date(T - 40 * DAY));
    const own = m.transcript('88888888-8888-4888-8888-888888888888', 2, JSON.stringify({ type: 'user', message: { role: 'user', content: 'wybe-connect distil run (started in the background by the wybe-connect plugin, not by a person).\nmode: ongoing' } }));
    importNow(m, node, new Date(T).toISOString());
    const r = await cycle(m, T);
    assert.deepEqual(r.plan.transcripts.map((t) => t.path), [recent]);
    assert.ok(!r.plan.transcripts.some((t) => t.path === old || t.path === own));
    assert.doesNotMatch(D.buildPrompt(r.plan), /transcripts from the last \d+ days under/, 'the model is not sent to find transcripts itself');
    assert.match(D.buildPrompt(r.plan), /read only those ranges/i);
  } finally {
    node.close();
  }
});

test('a mark goes when its transcript is gone, so the marks stay as many as the transcripts on disk', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    saveCredentials(creds(node.url), m.p);
    const T = Date.now();
    const a = m.transcript('99999999-9999-4999-8999-999999999999', 2);
    D.noteSession(m.p, { transcriptPath: a, now: T });
    await cycle(m, T);
    assert.equal(D.markOf(D.loadState(m.p), NODE_A, a), 2);
    unlinkSync(a);
    const b = m.transcript('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2);
    D.noteSession(m.p, { transcriptPath: b, now: T + 7 * H });
    await cycle(m, T + 7 * H);
    const s = D.loadState(m.p);
    assert.equal(D.markOf(s, NODE_A, a), null);
    assert.equal(D.markOf(s, NODE_A, b), 2);
  } finally {
    node.close();
  }
});

test('the marks are per node: another colleague\'s import reads the session again, each node stores it once', async () => {
  const m = machine();
  const a = await httpNode();
  const b = await httpNode();
  try {
    saveCredentials(creds(a.url, NODE_A), m.p);
    const T = Date.now();
    const s1 = m.transcript('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2);
    D.noteSession(m.p, { transcriptPath: s1, now: T });
    await cycle(m, T);
    saveCredentials(creds(b.url, NODE_B), m.p);
    importNow(m, b, new Date(T + H).toISOString());
    const r = await cycle(m, T + H);
    assert.equal(r.plan.mode, 'import');
    assert.deepEqual(ranges(r), ['1-2']);
    assert.deepEqual(twice(a.stored), []);
    assert.deepEqual(twice(b.stored), []);
    assert.equal(b.stored.filter((f) => f.startsWith('bbbbbbbb')).length, 2);
  } finally {
    a.close();
    b.close();
  }
});
