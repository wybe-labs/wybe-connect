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

test('memory files past the per-run cap are read by a later run of their own, with no new session', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    saveCredentials(creds(node.url), m.p);
    const T = Date.now();
    const demo = m.project('demo-app');
    demo.transcript(uuid(1), T - 30 * DAY);
    const dir = join(demo.dir, 'memory');
    mkdirSync(dir, { recursive: true });
    const n = D.MAX_RUN_MEMORY_FILES + 5;
    const all = [];
    for (let i = 0; i < n; i++) {
      const f = join(dir, `topic-${String(i).padStart(3, '0')}.md`);
      writeFileSync(f, `- topic ${i}\n`);
      all.push(f);
    }
    assert.equal(D.requestImport(m.p, new Date(T).toISOString()), true);
    const r1 = await cycle(m.p, m, T);
    assert.equal(r1.outcome.ok, true);
    assert.equal(r1.plan.memory.length, D.MAX_RUN_MEMORY_FILES, 'one run reads at most the cap');
    assert.equal(D.loadState(m.p).pending.length, 0, 'no transcript waits');
    const r2 = await cycle(m.p, m, T + D.BACKLOG_INTERVAL_MS + MIN);
    assert.equal(r2.plan?.mode, 'ongoing', 'a run for the memory left over');
    assert.deepEqual(r2.plan.transcripts, []);
    assert.deepEqual([...r1.plan.memory, ...r2.plan.memory].map((f) => f.path).sort(), [...all].sort(), 'every file read once');
    assert.equal(r2.outcome.ok, true);
    assert.equal(plan(m.p, m, T + 2 * D.BACKLOG_INTERVAL_MS + 2 * MIN), null, 'nothing left');
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

/** Two projects on one machine: `other` is pinned to Y, `mine` is X's; each has auto memory and a CLAUDE.md in its folder. */
function pinnedProjects(T) {
  const c = twoConnections();
  const withMemory = (name, id, to) => {
    const pr = c.m.project(name);
    const f = pr.transcript(uuid(id), T - 20 * DAY);
    if (to) C.sessionPaths(c.root, { sessionId: uuid(id), env: { WYBE_CONNECT_NODE: to }, transcriptPath: f });
    mkdirSync(join(pr.dir, 'memory'), { recursive: true });
    const memory = join(pr.dir, 'memory', 'MEMORY.md');
    writeFileSync(memory, `- notes of ${name}\n`);
    writeFileSync(join(pr.folder, 'CLAUDE.md'), `Rules of ${name}.\n`);
    return { ...pr, f, memory };
  };
  return { ...c, other: withMemory('other-employer', 1, c.y), mine: withMemory('mine', 2, null) };
}

test('an import never lists or claims the memory of a project whose sessions are pinned to another connection', () => {
  const T = Date.now();
  const { m, x, px, py, other, mine } = pinnedProjects(T);
  assert.equal(D.requestImport(px, new Date(T).toISOString()), true);
  const pl = plan(px, m, T);
  assert.deepEqual(pl.transcripts.map((t) => t.path), [mine.f]);
  assert.deepEqual(pl.memory.map((f) => f.path).sort(), [mine.memory, join(mine.folder, 'CLAUDE.md')].sort(), 'only the memory of the projects this connection takes');
  assert.ok(!D.buildPrompt(pl).includes(other.dir), 'the other project is not named in the prompt');
  assert.equal(claimOf(px.root, other.memory), null, 'not claimed by X');
  assert.equal(claimOf(px.root, mine.memory), x);
  assert.equal(D.requestImport(py, new Date(T + MIN).toISOString()), true);
  const py1 = plan(py, m, T + MIN);
  assert.deepEqual(py1.transcripts.map((t) => t.path), [other.f]);
  assert.deepEqual(py1.memory.map((f) => f.path).sort(), [other.memory, join(other.folder, 'CLAUDE.md')].sort(), 'Y gets the memory of its own project');
});

test('an ongoing run lists the memory of its own transcripts\' projects only', () => {
  const T = Date.now();
  const { m, root, x, px, other, mine } = pinnedProjects(T);
  const later = mine.transcript(uuid(3), T - H);
  C.sessionPaths(root, { sessionId: uuid(3), env: { WYBE_CONNECT_NODE: x }, transcriptPath: later });
  D.noteSession(px, { transcriptPath: later, sessionId: uuid(3), now: T - H });
  const pl = plan(px, m, T);
  assert.equal(pl.mode, 'ongoing');
  assert.deepEqual(pl.transcripts.map((t) => t.path), [later]);
  assert.ok(pl.memory.every((f) => !f.path.startsWith(other.dir)), 'no memory of the project pinned to Y');
  assert.ok(pl.memory.some((f) => f.path === mine.memory), 'its own project\'s memory');
  assert.equal(claimOf(px.root, other.memory), null);
});

test('a failed ongoing run gives the home CLAUDE.md back as the person\'s, never as a project file to claim', () => {
  const m = machine();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), m.p);
  const T = Date.now();
  const demo = m.project('demo-app');
  const f = demo.transcript(uuid(1), T - H);
  const global = join(m.claudeHome, 'CLAUDE.md');
  writeFileSync(global, 'Write tests first.\n');
  D.noteSession(m.p, { transcriptPath: f, sessionId: uuid(1), now: T - H });
  const pl = plan(m.p, m, T, { alive: () => false });
  assert.equal(pl.mode, 'ongoing');
  assert.ok(pl.memory.some((x) => x.path === global));
  assert.equal(plan(m.p, m, T + 3 * MIN, { alive: () => false }), null, 'the dead run is settled and backs off');
  const back = D.loadState(m.p).memoryBacklog.find((x) => x.path === global);
  assert.deepEqual(back, { path: global, shared: true }, 'the home file goes back as the person\'s');
  assert.equal(pl.claudeHome, m.claudeHome, 'an ongoing plan carries its home, as an import plan does');
});

// ------------------------------------------------------------------ the import reads the disk in chunks
/** `n` transcripts over three projects, oldest first by index, and an import request. */
function manyOnDisk(n) {
  const m = machine();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), m.p);
  const T = Date.now();
  const projects = ['a', 'b', 'c'].map((x) => m.project(`chunk-${x}`));
  const files = [];
  for (let i = 0; i < n; i++) files.push(projects[i % 3].transcript(uuid(i), T - (n - i) * MIN));
  assert.equal(D.requestImport(m.p, new Date(T).toISOString()), true);
  return { m, T, files };
}

test('an import request reads the disk a bounded chunk per tick, and the next tick goes on where the last stopped: none lost, none read twice', () => {
  const chunk = D.IMPORT_SCAN_FILES;
  assert.ok(Number.isInteger(chunk) && chunk > 0 && chunk <= 200, 'one tick reads a bounded number of transcripts');
  const n = 2 * chunk + 7;
  const { m, T, files } = manyOnDisk(n);
  assert.equal(plan(m.p, m, T), null, 'the first tick only reads');
  assert.equal(D.loadState(m.p).pending.length, chunk);
  assert.equal(plan(m.p, m, T), null);
  assert.equal(D.loadState(m.p).pending.length, 2 * chunk);
  const pl = plan(m.p, m, T);
  assert.equal(pl?.mode, 'import', 'the tick that reads the last chunk plans the import');
  assert.equal(pl.transcripts.length, D.MAX_RUN_TRANSCRIPTS);
  const seen = D.pendingView(m.p).map((x) => x.path);
  assert.equal(new Set(seen).size, seen.length, 'none twice');
  assert.deepEqual([...seen].sort(), [...files].sort(), 'every transcript on disk is in flight or pending');
  assert.equal(D.loadState(m.p).importScan ?? null, null, 'nothing left to read');
});

test('the MCP server\'s import ticks yield to its event loop between chunks, so it answers its client while an import reads the disk', async () => {
  const chunk = D.IMPORT_SCAN_FILES;
  assert.ok(Number.isInteger(chunk) && chunk > 0);
  assert.equal(typeof D.maybeRunUntilPlanned, 'function');
  const { m, T } = manyOnDisk(3 * chunk + 1);
  let done = false;
  let turns = 0;
  const spin = () => { turns += 1; if (!done) setImmediate(spin); };
  setImmediate(spin);
  let pl;
  try {
    pl = await D.maybeRunUntilPlanned({ paths: m.p, env: {}, now: T, spawnImpl: recorder, claudeHome: m.claudeHome });
  } finally {
    done = true;
  }
  assert.equal(pl?.mode, 'import');
  assert.ok(turns >= 3, `the event loop ran between the chunks (${turns} turns)`);
  assert.equal(D.pendingView(m.p).length, 3 * chunk + 1);
});

// ------------------------------------------------------------------ volume
test('an import of more transcripts than pending holds takes one run\'s worth and folds the rest as notes, none lost', () => {
  const m = machine();
  saveCredentials(creds('http://127.0.0.1:9/mcp'), m.p);
  const T = Date.now();
  const n = D.MAX_PENDING + 150;
  const projects = ['a', 'b', 'c', 'd', 'e'].map((x) => m.project(`proj-${x}`));
  // The oldest transcripts lie in the project the walk reads last: pending still keeps the oldest.
  for (let i = 0; i < n; i++) projects[projects.length - 1 - (i % projects.length)].transcript(uuid(i), T - (n - i) * MIN);
  assert.equal(D.requestImport(m.p, new Date(T).toISOString()), true);
  const t0 = Date.now();
  let pl = null;
  let ticks = 0;
  while (!pl && ticks < 100) {
    const t = Date.now();
    pl = plan(m.p, m, T);
    ticks += 1;
    assert.ok(Date.now() - t < 20000, 'one tick reads one chunk, never the whole disk');
  }
  assert.equal(ticks, Math.ceil(n / D.IMPORT_SCAN_FILES), 'a chunk a tick, the last one plans');
  assert.ok(Date.now() - t0 < 60000, 'planned in well under a minute');
  assert.equal(pl.transcripts.length, D.MAX_RUN_TRANSCRIPTS);
  assert.deepEqual([...new Set(pl.transcripts.map((t) => t.project))], ['proj-e'], 'one whole project at a time, the oldest first');
  assert.equal(D.pendingView(m.p).length, n, 'every transcript is pending, in flight or a note on disk');
  assert.equal(readdirSync(D.distilPaths(m.p).notes).length, n - D.MAX_PENDING);
});
