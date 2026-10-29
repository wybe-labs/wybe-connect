// The import reads every session still on disk, grouped by project, with the person's memory files,
// and the run sends one summary per project (lib/distil.js). Which connection an import may take a
// transcript no session pin assigns is lib/claims.js: the first import that takes it. The headless
// run is a fixture (never the real claude); the node is an in-process HTTP fake on 127.0.0.1. Every
// home is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// No test here may look at a real Claude Code home.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wybe-connect-no-home-'));

const PKG = join(import.meta.dirname, '..', 'packages', 'claude-code');
const lib = (f) => import(pathToFileURL(join(PKG, 'lib', f)).href);
const D = await lib('distil.js');
const C = await lib('connections.js');
const { paths, saveCredentials } = await lib('home.js');
const { readRecords } = await lib('ledger.js');
const { claimOf } = await lib('claims.js');
const SUMMARY = join(import.meta.dirname, 'fixtures', 'project-summary-claude.mjs');
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-distil-claude.mjs');
const runner = (f) => () => ({ cmd: process.execPath, pre: [f] });

const MIN = 60 * 1000;
const H = 60 * MIN;
const DAY = 24 * H;
const NODE = 'https://node-a.example.invalid';
const tok = (c = 'q') => ['wat', c.repeat(40)].join('_');
const creds = (endpoint, nodeUrl = NODE) => ({ nodeUrl, resource: endpoint, mcpEndpoint: endpoint, issuer: 'https://auth.example.invalid', tokenEndpoint: 'https://auth.example.invalid/oauth/token', clientId: 'c1', accessToken: tok(), refreshToken: null, expiresAt: null, scopes: ['remember'] });
const recorder = () => ({ pid: 4242, on() {}, unref() {} });

/**
 * A person's machine: a Claude Code home whose projects/ holds one folder per project, and each
 * project's own working folder (its cwd) on disk. A transcript's second line carries the cwd, as
 * Claude Code writes it after a first line without one.
 */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-projects-'));
  const claudeHome = join(root, 'claude');
  const work = join(root, 'work');
  const project = (name, { cwd = true } = {}) => {
    const dir = join(claudeHome, 'projects', `C--work-${name}`);
    const folder = join(work, name);
    mkdirSync(dir, { recursive: true });
    mkdirSync(folder, { recursive: true });
    const transcript = (id, at, n = 2) => {
      const f = join(dir, `${id}.jsonl`);
      const lines = [JSON.stringify({ type: 'summary', summary: 'x' })];
      for (let i = 1; i < n; i++) lines.push(JSON.stringify({ type: i % 2 ? 'user' : 'assistant', n: i + 1, ...(cwd ? { cwd: folder } : {}) }));
      writeFileSync(f, `${lines.join('\n')}\n`);
      utimesSync(f, new Date(at), new Date(at));
      return f;
    };
    return { dir, folder, transcript };
  };
  return { root, claudeHome, project, p: paths(join(root, 'wybe-connect')) };
}

const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** A node that keeps an idempotency_key once and confirms the import it asked for. Every item is kept. */
async function httpNode() {
  const items = [];
  const first = new Map();
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
        items.push(...(args.items ?? []));
        answer = { ok: true, stored: (args.items ?? []).length, answered: 0, open_questions: [], ...(args.import_of ? { import_done: true } : {}) };
        first.set(args.idempotency_key, answer);
      }
      text(answer);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, items, close: () => { server.closeAllConnections?.(); server.close(); } };
}

const plan = (p, m, now, opts = {}) => D.maybeRun({ paths: p, env: {}, now, spawnImpl: recorder, claudeHome: m.claudeHome, ...opts });
const cycle = async (p, m, now, resolve = runner(FAKE)) => {
  const pl = plan(p, m, now);
  if (!pl) return { plan: null };
  return { plan: pl, outcome: await D.runWatchdog(pl.planFile, { paths: p, now: () => now, resolve }) };
};

// ------------------------------------------------------------------ projects
test('an import takes whole projects, oldest project first by its oldest transcript, never splitting one while the caps allow', () => {
  const m = machine();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), m.p);
  const T = Date.now();
  const alpha = m.project('alpha-app');
  const beta = m.project('beta-api');
  const gamma = m.project('gamma', { cwd: false }); // no line carries a cwd: the projects/<dir> name decides
  const files = { 'alpha-app': [], 'beta-api': [], gamma: [] };
  // 3 projects, 15 transcripts each, their times interleaved: beta's oldest is the oldest of all.
  for (let i = 0; i < 15; i++) {
    files['beta-api'].push(beta.transcript(uuid(100 + i), T - (300 - 3 * i) * DAY));
    files['alpha-app'].push(alpha.transcript(uuid(200 + i), T - (299 - 3 * i) * DAY));
    files.gamma.push(gamma.transcript(uuid(300 + i), T - (298 - 3 * i) * DAY));
  }
  assert.equal(D.requestImport(m.p, new Date(T).toISOString()), true);
  const pl = plan(m.p, m, T);
  assert.equal(pl.mode, 'import');
  assert.equal(pl.transcripts.length, D.MAX_RUN_TRANSCRIPTS);
  assert.deepEqual(pl.transcripts.map((t) => t.project), [...Array(15).fill('beta-api'), ...Array(15).fill('alpha-app'), ...Array(10).fill('gamma')], 'whole projects, in the order of their oldest transcript');
  assert.deepEqual(pl.transcripts.slice(0, 15).map((t) => t.path), files['beta-api'], 'oldest first inside a project');
  const prompt = D.buildPrompt(pl);
  for (const name of ['beta-api', 'alpha-app', 'gamma']) assert.match(prompt, new RegExp(`^Project ${name}:$`, 'm'), `${name} is named`);
  const at = (s) => prompt.indexOf(s);
  assert.ok(at('Project beta-api:') < at(files['beta-api'][0]) && at(files['beta-api'][14]) < at('Project alpha-app:'), 'each project heads its own ranges');
  assert.doesNotMatch(prompt, /^Project .*[\\/]/m, 'a project is named by the last part of its folder, never a path');
});

test('an import prompt names no age window, lists the memory files by path, and asks for one summary per project', () => {
  const m = machine();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), m.p);
  const T = Date.now();
  const demo = m.project('demo-app');
  const t = demo.transcript(uuid(1), T - 90 * DAY);
  writeFileSync(join(m.claudeHome, 'CLAUDE.md'), 'Write tests first.\n');
  mkdirSync(join(demo.dir, 'memory', 'notes'), { recursive: true });
  writeFileSync(join(demo.dir, 'memory', 'MEMORY.md'), '- the deploy runs on Fridays\n');
  writeFileSync(join(demo.dir, 'memory', 'notes', 'stack.md'), '- the stack is plain Node\n');
  writeFileSync(join(demo.dir, 'memory', 'ignore.txt'), 'not a memory file\n');
  writeFileSync(join(demo.folder, 'CLAUDE.md'), 'Project rules.\n');
  mkdirSync(join(demo.folder, '.claude'), { recursive: true });
  writeFileSync(join(demo.folder, '.claude', 'CLAUDE.md'), 'More project rules.\n');
  assert.equal(D.requestImport(m.p, new Date(T).toISOString()), true);
  const pl = plan(m.p, m, T);
  assert.deepEqual(pl.transcripts.map((x) => [x.path, x.project]), [[t, 'demo-app']]);
  const want = [join(m.claudeHome, 'CLAUDE.md'), join(demo.dir, 'memory', 'MEMORY.md'), join(demo.dir, 'memory', 'notes', 'stack.md'), join(demo.folder, 'CLAUDE.md'), join(demo.folder, '.claude', 'CLAUDE.md')];
  assert.deepEqual(pl.memory.map((x) => x.path).sort(), [...want].sort());
  const prompt = D.buildPrompt(pl);
  assert.doesNotMatch(prompt, /last \d+ days/);
  assert.match(prompt, /every Claude Code session still on this machine that is not distilled yet, grouped by project/);
  for (const f of want) assert.ok(prompt.includes(f), `${f} is listed`);
  assert.ok(!prompt.includes('ignore.txt'));
  assert.match(prompt, /^Project demo-app:$/m);
  assert.match(prompt, /subject: <the project's name/);
  assert.match(prompt, /category: insight/);
  assert.match(prompt, /"Project summary:"/);
  assert.match(prompt, /at most 3000 characters/);
  assert.match(prompt, /at most 40 facts plus one summary per project/);
});

test('a memory file is listed again only when it changed: the next ongoing run lists the changed one, never the unchanged one; marks are per node', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    saveCredentials(creds(node.url), m.p);
    const T = Date.now();
    const demo = m.project('demo-app');
    demo.transcript(uuid(1), T - 90 * DAY);
    const global = join(m.claudeHome, 'CLAUDE.md');
    const memory = join(demo.dir, 'memory', 'MEMORY.md');
    writeFileSync(global, 'Write tests first.\n');
    mkdirSync(join(demo.dir, 'memory'), { recursive: true });
    writeFileSync(memory, '- the deploy runs on Fridays\n');
    assert.equal(D.requestImport(m.p, new Date(T).toISOString()), true);
    const r1 = await cycle(m.p, m, T);
    assert.equal(r1.outcome.ok, true);
    assert.deepEqual(r1.plan.memory.map((x) => x.path).sort(), [global, memory].sort());
    let s = D.loadState(m.p);
    assert.deepEqual(Object.keys(s.memoryMarks[NODE]).sort(), [global, memory].sort(), 'marked for this node after the whole outbox');
    writeFileSync(memory, '- the deploy runs on Thursdays now\n');
    const later = demo.transcript(uuid(2), T + H);
    D.noteSession(m.p, { transcriptPath: later, sessionId: 's2', now: T + H });
    const r2 = await cycle(m.p, m, T + 7 * H);
    assert.equal(r2.plan.mode, 'ongoing');
    assert.deepEqual(r2.plan.memory.map((x) => x.path), [memory], 'only the changed file');
    assert.match(D.buildPrompt(r2.plan), /changed since they were last read/);
    const appended = demo.transcript(uuid(3), T + 8 * H);
    D.noteSession(m.p, { transcriptPath: appended, sessionId: 's3', now: T + 8 * H });
    const r3 = await cycle(m.p, m, T + 15 * H);
    assert.deepEqual(r3.plan.memory, [], 'nothing changed since');
  } finally {
    node.close();
  }
});

test('a summary item per project reaches the node with its subject intact through cleaning and redaction', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    saveCredentials(creds(node.url), m.p);
    const T = Date.now();
    m.project('demo-app').transcript(uuid(1), T - 50 * DAY);
    m.project('ops-tools').transcript(uuid(2), T - 40 * DAY);
    assert.equal(D.requestImport(m.p, new Date(T).toISOString()), true);
    const r = await cycle(m.p, m, T, runner(SUMMARY));
    assert.equal(r.outcome.ok, true);
    assert.equal(r.outcome.importDone, true);
    const summaries = node.items.filter((x) => x.content.startsWith('Project summary:'));
    assert.deepEqual(summaries.map((x) => [x.subject, x.category]), [['demo-app', 'insight'], ['ops-tools', 'insight']]);
    assert.ok(summaries.every((x) => !x.content.includes('ops@example.invalid')), 'the content is still redacted');
    const acks = readRecords(D.distilPaths(m.p).acks(r.plan.runId)).records;
    assert.equal(acks.length, 0, 'a whole success removes the run files');
  } finally {
    node.close();
  }
});

// ------------------------------------------------------------------ claims
function twoConnections() {
  const m = machine();
  const root = join(m.root, 'wybe-connect', 'claude-code');
  const grant = (c) => ({ nodeUrl: `https://node-${c}.example.invalid`, resource: `https://node-${c}.example.invalid/mcp`, mcpEndpoint: `https://node-${c}.example.invalid/mcp`, issuer: 'https://auth.example.invalid', tokenEndpoint: 'https://auth.example.invalid/token', clientId: 'wybe-connect-claude-code', accessToken: tok(c), refreshToken: null, expiresAt: null, scopes: ['remember'] });
  const x = C.saveConnection(root, grant('x'));
  const y = C.saveConnection(root, grant('y'));
  return { m, root, x, y, px: C.connectionPaths(root, x), py: C.connectionPaths(root, y) };
}

test('an unpinned transcript imported by connection X is skipped by connection Y', () => {
  const { m, x, px, py } = twoConnections();
  const T = Date.now();
  const old = m.project('demo-app').transcript(uuid(1), T - 200 * DAY);
  assert.equal(D.requestImport(px, new Date(T).toISOString()), true);
  assert.deepEqual(plan(px, m, T).transcripts.map((t) => t.path), [old], 'the first import takes it');
  assert.equal(D.requestImport(py, new Date(T + MIN).toISOString()), true);
  const pl = plan(py, m, T + MIN);
  assert.equal(pl.mode, 'import');
  assert.deepEqual(pl.transcripts, [], 'claimed by the first connection');
  assert.equal(claimOf(px.root, old), x, 'the claim names the connection');
});

test('a pinned transcript follows its pin, whichever import runs first', () => {
  const { m, root, y, px, py } = twoConnections();
  const T = Date.now();
  const f = m.project('demo-app').transcript(uuid(7), T - 10 * DAY);
  C.sessionPaths(root, { sessionId: uuid(7), env: { WYBE_CONNECT_NODE: y }, transcriptPath: f });
  assert.equal(D.requestImport(px, new Date(T).toISOString()), true);
  assert.deepEqual(plan(px, m, T).transcripts, [], 'X never takes a session pinned to Y');
  assert.equal(D.requestImport(py, new Date(T + MIN).toISOString()), true);
  assert.deepEqual(plan(py, m, T + MIN).transcripts.map((t) => t.path), [f]);
});

test('project memory goes to the first connection whose run lists it; the home CLAUDE.md goes to each', () => {
  const { m, px, py } = twoConnections();
  const T = Date.now();
  const demo = m.project('demo-app');
  demo.transcript(uuid(1), T - 200 * DAY);
  const global = join(m.claudeHome, 'CLAUDE.md');
  writeFileSync(global, 'Write tests first.\n');
  mkdirSync(join(demo.dir, 'memory'), { recursive: true });
  const memory = join(demo.dir, 'memory', 'MEMORY.md');
  writeFileSync(memory, '- the deploy runs on Fridays\n');
  assert.equal(D.requestImport(px, new Date(T).toISOString()), true);
  assert.deepEqual(plan(px, m, T).memory.map((x) => x.path).sort(), [global, memory].sort());
  assert.equal(D.requestImport(py, new Date(T + MIN).toISOString()), true);
  assert.deepEqual(plan(py, m, T + MIN).memory.map((x) => x.path), [global]);
});

// ------------------------------------------------------------------ volume
test('an import of more transcripts than pending holds takes one run\'s worth and folds the rest as notes, none lost', () => {
  const m = machine();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), m.p);
  const T = Date.now();
  const n = D.MAX_PENDING + 150;
  const projects = ['a', 'b', 'c', 'd', 'e'].map((x) => m.project(`proj-${x}`));
  for (let i = 0; i < n; i++) projects[i % projects.length].transcript(uuid(i), T - (n - i) * MIN);
  assert.equal(D.requestImport(m.p, new Date(T).toISOString()), true);
  const t0 = Date.now();
  const pl = plan(m.p, m, T);
  assert.ok(Date.now() - t0 < 60000, 'planned in well under a minute');
  assert.equal(pl.transcripts.length, D.MAX_RUN_TRANSCRIPTS);
  assert.deepEqual([...new Set(pl.transcripts.map((t) => t.project))], ['proj-a'], 'one whole project at a time');
  assert.equal(D.pendingView(m.p).length, n, 'every transcript is pending, in flight or a note on disk');
  assert.equal(readdirSync(D.distilPaths(m.p).notes).length, n - D.MAX_PENDING);
});
