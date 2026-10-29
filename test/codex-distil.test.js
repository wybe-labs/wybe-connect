// The background distil for Codex: the same produce-then-deliver pipeline as Claude Code
// (lib/distil.js), with `codex exec` as the headless run and Codex rollouts as the transcripts.
// The run is always test/fixtures/fake-codex.mjs (never a real codex), through
// WYBE_CONNECT_CODEX_BIN or an explicit `resolve`. The node is an in-process HTTP fake on
// 127.0.0.1. The Codex home (CODEX_HOME) and the wybe-connect home are temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// No test here may look at a real Codex or Claude Code home.
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'wybe-connect-no-codex-home-'));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wybe-connect-no-claude-home-'));

const ROOT = join(import.meta.dirname, '..');
const PKG = join(ROOT, 'packages', 'codex');
const lib = (f) => import(pathToFileURL(join(PKG, 'lib', f)).href);
const D = await lib('distil.js');
const C = await lib('connections.js');
const { createProxy } = await lib('mcp-proxy.js');
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const resolveFake = () => ({ cmd: process.execPath, pre: [FAKE] });

const MIN = 60 * 1000;
const H = 60 * MIN;
const DAY = 24 * H;
const TOKEN = ['wat_', 'c0Dx9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');
const SECRET = ['sk', 'proj', 'Pl4ntedSecretValue0123456789abcdefABCDEF'].join('-');
const PLANTED = ['PLANTED-PROMPT', 'PLANTED-ASSISTANT-SENTENCE', 'PLANTED-TOOL-OUTPUT', 'PLANTED-AGENTS-MD', SECRET];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t = Date.now(); for (;;) { const x = fn(); if (x) return x; if (Date.now() - t > ms) return null; await sleep(100); } }

/** A person's machine: the wybe-connect home, its Codex connection, and a Codex home with sessions/. */
function machine() {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-codex-distil-'));
  const home = join(dir, 'wybe-connect');
  const codexRoot = join(home, 'codex'); // lib/home.js harnessHome('codex')
  const codexHome = join(dir, 'codex-home');
  const project = join(dir, 'atlas-demo');
  mkdirSync(project, { recursive: true });
  const rollout = (id, { day = '20', source = 'cli', prompt = `PLANTED-PROMPT make the retry loop stop at five, key ${SECRET}`, extra = 2, ext = '.jsonl' } = {}) => {
    const d = join(codexHome, 'sessions', '2026', '10', day);
    mkdirSync(d, { recursive: true });
    const f = join(d, `rollout-2026-10-${day}T09-00-00-${id}${ext}`);
    const lines = [
      { type: 'session_meta', payload: { id, cwd: project, source, cli_version: '0.155.0', git: { branch: 'feat/retry' } } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PLANTED-AGENTS-MD house rules' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PLANTED-ASSISTANT-SENTENCE capped at five.' }] } },
    ];
    for (let i = 0; i < extra; i++) lines.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: `c${i}`, output: `PLANTED-TOOL-OUTPUT ${i}` } });
    writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return f;
  };
  return { dir, home, codexRoot, codexHome, project, rollout };
}

function connect(m, nodeBase, scopes = ['remember']) {
  const key = C.saveConnection(m.codexRoot, {
    nodeUrl: nodeBase, resource: `${nodeBase}/mcp`, mcpEndpoint: `${nodeBase}/mcp`, issuer: 'http://127.0.0.1:9', tokenEndpoint: 'http://127.0.0.1:9/oauth/token',
    clientId: 'wybe-connect-codex', accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes,
  });
  return C.connectionPaths(m.codexRoot, key);
}

/** A node that keeps an idempotency_key once, asks for an import when told, and confirms it. Every request body is kept. */
async function httpNode() {
  const stored = [];
  const bodies = [];
  const calls = [];
  const first = new Map();
  let importPending = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      bodies.push(body);
      const msg = JSON.parse(body || '{}');
      const json = (o, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remember', inputSchema: { type: 'object' } }, { name: 'pending_questions', inputSchema: { type: 'object' } }] } });
      if (msg.method !== 'tools/call') { res.writeHead(200); return res.end(); }
      calls.push(msg.params?.name);
      const args = msg.params?.arguments ?? {};
      const text = (o) => json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
      if (msg.params?.name !== 'remember') return text({ ok: true, open_questions: [], ...(importPending ? { import_request: { requested_at: importPending } } : {}) });
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
  return { base: `http://127.0.0.1:${server.address().port}`, stored, bodies, calls, requestImport: (at) => { importPending = at; }, close: () => { server.closeAllConnections?.(); server.close(); } };
}

const recorder = () => { const spawns = []; return { spawns, spawnImpl: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { pid: 4242, on() {}, unref() {} }; } }; };
const twice = (xs) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
const factsOf = (stored, file) => stored.filter((f) => f.startsWith(`${basename(file)}#`));
const logLines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const rolloutsUnder = (codexHome) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(e.name)); };
  if (existsSync(join(codexHome, 'sessions'))) walk(join(codexHome, 'sessions'));
  return out.sort();
};

// ------------------------------------------------------------------ the headless run
test('codex exec: read-only sandbox, JSON events, ephemeral, no git check, no hooks of the person, only the plugin\'s own server, in distil mode', () => {
  const plan = { runId: 'r-1', mode: 'ongoing', harness: 'codex', connection: 'node', transcripts: [{ path: '/x/rollout-a.jsonl', fromLine: 0, toLine: 4 }] };
  const args = D.codexArgs(plan, { root: '/h/wybe-connect/codex', pluginRoot: '/plugins/wybe-connect' });
  assert.equal(args[0], 'exec');
  const prompt = args[args.length - 1];
  assert.deepEqual(args.slice(1, -1), [
    '--sandbox', 'read-only',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '-c', 'features.hooks=false',
    '-c', 'mcp_servers={}',
    '-c', `mcp_servers.wybe_distil.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.wybe_distil.args=${JSON.stringify([join('/plugins/wybe-connect', 'bin', 'mcp-proxy.js')])}`,
    '-c', 'mcp_servers.wybe_distil.env={ WYBE_CONNECT_DISTIL = "r-1", WYBE_CONNECT_HOME = "/h/wybe-connect", WYBE_CONNECT_NODE = "node" }',
  ]);
  assert.ok(prompt.startsWith('wybe-connect distil run'), 'the prompt marks the run as a distil run');
  assert.match(prompt, /^- \/x\/rollout-a\.jsonl lines 1-4$/m);
  assert.match(prompt, /read only those ranges/i);
  assert.doesNotMatch(prompt, /Read tool/, 'Codex reads with its read-only shell, not a Read tool');
  assert.match(prompt, /with the wybe_distil server's remember tool/, 'the run names its own server, never the plugin\'s interactive one');
});

test('codex exec: a Windows path in the server command is valid TOML in the override', () => {
  const plan = { runId: 'r-2', mode: 'ongoing', harness: 'codex', connection: null, transcripts: [] };
  const args = D.codexArgs(plan, { root: 'C:\\Users\\person\\.wybe-connect\\codex', pluginRoot: 'C:\\plugins\\wybe-connect' });
  const env = args.find((a) => a.startsWith('mcp_servers.wybe_distil.env='));
  assert.ok(env.includes('WYBE_CONNECT_HOME = "C:\\\\Users\\\\person\\\\.wybe-connect'), env);
  const cmdArgs = args.find((a) => a.startsWith('mcp_servers.wybe_distil.args='));
  assert.deepEqual(JSON.parse(cmdArgs.slice('mcp_servers.wybe_distil.args='.length)), [join('C:\\plugins\\wybe-connect', 'bin', 'mcp-proxy.js')]);
});

test('resolveCodex: an override, codex(.exe) on PATH, or the npm shim\'s codex.js under Node; null when none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-path-'));
  assert.deepEqual(D.resolveCodex({ WYBE_CONNECT_CODEX_BIN: FAKE }), { cmd: process.execPath, pre: [FAKE] });
  assert.equal(D.resolveCodex({ PATH: dir }, 'linux'), null);
  writeFileSync(join(dir, 'codex.cmd'), '@echo off\n');
  assert.equal(D.resolveCodex({ PATH: dir }, 'win32'), null, 'a .cmd shim is not started without its codex.js');
  const cli = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  mkdirSync(join(cli, '..'), { recursive: true });
  writeFileSync(cli, '');
  assert.deepEqual(D.resolveCodex({ PATH: dir }, 'win32'), { cmd: process.execPath, pre: [cli] });
  writeFileSync(join(dir, 'codex'), '');
  assert.deepEqual(D.resolveCodex({ PATH: dir }, 'linux'), { cmd: join(dir, 'codex'), pre: [] });
});

test('the import lists the person\'s rollouts of the last 30 days: no subagent, no distil run, no compressed or other file', () => {
  const m = machine();
  const T = Date.now();
  const recent = m.rollout('0190c0de-0000-7000-8000-000000000001');
  const resumed = m.rollout('0190c0de-0000-7000-8000-000000000002', { day: '01' }); // made long ago, written to yesterday
  utimesSync(resumed, new Date(T - DAY), new Date(T - DAY));
  const old = m.rollout('0190c0de-0000-7000-8000-000000000003');
  utimesSync(old, new Date(T - 40 * DAY), new Date(T - 40 * DAY));
  m.rollout('0190c0de-0000-7000-8000-000000000004', { source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } } });
  m.rollout('0190c0de-0000-7000-8000-000000000005', { source: 'exec', prompt: 'wybe-connect distil run (started in the background by the wybe-connect plugin, not by a person).\nmode: ongoing' });
  m.rollout('0190c0de-0000-7000-8000-000000000006', { ext: '.jsonl.zst' });
  writeFileSync(join(m.codexHome, 'sessions', '2026', '10', '20', 'notes.jsonl'), '{}\n');
  const list = D.importRollouts(m.codexHome, T);
  assert.deepEqual(list.map((t) => t.path).sort(), [recent, resumed].sort());
  assert.deepEqual(list.map((t) => t.sessionId).sort(), ['0190c0de-0000-7000-8000-000000000001', '0190c0de-0000-7000-8000-000000000002']);
});

test('a Codex import plan: the rollouts are the ranges, the prompt names Codex\'s own AGENTS.md, and the run is planned for codex', () => {
  const m = machine();
  const p = connect(m, 'http://127.0.0.1:9');
  const a = m.rollout('0190c0de-0000-7000-8000-00000000000a');
  assert.equal(D.requestImport(p, '2026-10-26T10:00:00.000Z'), true);
  const rec = recorder();
  const plan = D.maybeRun({ paths: p, env: {}, now: Date.now(), spawnImpl: rec.spawnImpl, harness: 'codex', codexHome: m.codexHome });
  assert.equal(plan.mode, 'import');
  assert.equal(plan.harness, 'codex');
  assert.deepEqual(plan.transcripts.map((t) => [t.path, t.fromLine, t.toLine]), [[a, 0, 6]]);
  const prompt = D.buildPrompt(plan);
  assert.ok(prompt.includes(join(m.codexHome, 'AGENTS.md')));
  assert.match(prompt, /Codex session/);
  assert.equal(rec.spawns[0].opts.env.WYBE_CONNECT_HOME, m.home, 'the watchdog gets the wybe-connect home, not the Codex one inside it');
  assert.match(rec.spawns[0].args[0], /packages[\\/]codex[\\/]bin[\\/]distil-run\.js$/);
});

test('a Claude Code plan is unchanged by the Codex runner: claude -p, its own transcripts', () => {
  const plan = { runId: 'r-3', mode: 'ongoing', connection: null, transcripts: [] };
  assert.equal(D.claudeArgs(plan, { root: '/h' })[0], '-p');
  assert.match(D.buildPrompt(plan), /with the Read tool/);
  assert.match(D.buildPrompt(plan), /with the wybe server's remember tool/);
});

// ------------------------------------------------------------------ through the watchdog
test('a Codex run through the watchdog: the fake codex distils the noted rollout, and only its facts reach the node', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    const p = connect(m, node.base);
    const a = m.rollout('0190c0de-0000-7000-8000-0000000000b1');
    D.noteSession(p, { transcriptPath: a, sessionId: '0190c0de-0000-7000-8000-0000000000b1', now: Date.now() - 7 * H });
    const plan = D.maybeRun({ paths: p, env: {}, now: Date.now(), spawnImpl: recorder().spawnImpl, harness: 'codex', codexHome: m.codexHome });
    assert.equal(plan.harness, 'codex');
    const log = join(m.dir, 'fake.log');
    process.env.FAKE_LOG = log;
    let out;
    try {
      out = await D.runWatchdog(plan.planFile, { paths: p, resolve: resolveFake });
    } finally {
      delete process.env.FAKE_LOG;
    }
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(node.stored, [1, 2, 3, 4, 5, 6].map((i) => `${basename(a)}#${i}`));
    const ran = logLines(log)[0];
    assert.deepEqual(ran.servers, ['wybe_distil'], 'the person\'s own MCP servers are not in the run');
    assert.deepEqual([...ran.tools].sort(), ['distil_done', 'pending_questions', 'remember']);
    assert.ok(ran.flags.includes('--ephemeral'));
    assert.ok(ran.flags.includes('sandbox=read-only'));
    assert.equal(ran.env.distil, plan.runId);
    for (const needle of PLANTED) assert.ok(!node.bodies.join('\n').includes(needle), `${needle} reached the node`);
  } finally {
    node.close();
  }
});

// ------------------------------------------------------------------ as real processes
const HOOKS = join(PKG, 'hooks');

function runNode(script, { input = null, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input === null ? '' : JSON.stringify(input));
  });
}

const envOf = (m, extra = {}) => {
  const base = { ...process.env };
  delete base.WYBE_CONNECT_NODE;
  delete base.WYBE_CONNECT_DISTIL;
  return { ...base, WYBE_CONNECT_HOME: m.home, CODEX_HOME: m.codexHome, WYBE_CONNECT_CODEX_BIN: FAKE, ...extra };
};

const stopInput = (m, rollout, sessionId, extra = {}) => ({ session_id: sessionId, transcript_path: rollout, cwd: m.project, hook_event_name: 'Stop', model: 'gpt-5.5-codex', turn_id: 't-1', stop_hook_active: false, last_assistant_message: 'PLANTED-ASSISTANT-SENTENCE', ...extra });

test('Codex Stop hook: sends nothing itself, notes the rollout, and the background run delivers its essence once', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    const p = connect(m, node.base);
    const sid = '0190c0de-0000-7000-8000-0000000000c1';
    const a = m.rollout(sid);
    const log = join(m.dir, 'fake.log');
    const r = await runNode(join(HOOKS, 'flush.js'), { input: stopInput(m, a, sid), env: envOf(m, { FAKE_LOG: log }) });
    assert.deepEqual(r, { code: 0, stdout: '', stderr: '' }, 'Codex parses stdout as hook output: the hook prints nothing');
    assert.ok(await waitFor(() => D.loadState(p).lastSuccessAt), 'the run delivered');
    assert.deepEqual([...new Set(node.calls)], ['remember'], 'no report_session: only distilled facts');
    assert.deepEqual(factsOf(node.stored, a).length, 6);
    assert.equal(existsSync(join(m.codexRoot, 'connections', p.connection, 'queue')), false, 'no rollout delta queued');
    for (const needle of PLANTED) assert.ok(!node.bodies.join('\n').includes(needle), `${needle} reached the node`);
  } finally {
    node.close();
  }
});

test('Codex hooks note nothing for a subagent, a subagent\'s PreCompact, a compressed rollout, inside a distil run, or without remember', async () => {
  const m = machine();
  const p = connect(m, 'http://127.0.0.1:9');
  const sub = m.rollout('0190c0de-0000-7000-8000-0000000000d1', { source: { subagent: 'review' } });
  const main = m.rollout('0190c0de-0000-7000-8000-0000000000d2');
  const zst = m.rollout('0190c0de-0000-7000-8000-0000000000d3', { ext: '.jsonl.zst' });
  const hook = (input, extra = {}) => runNode(join(HOOKS, 'flush.js'), { input, env: envOf(m, extra) });
  assert.deepEqual(await hook(stopInput(m, sub, 'sub')), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await hook({ ...stopInput(m, main, 'main'), hook_event_name: 'PreCompact', agent_id: 'a-1' }), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await hook(stopInput(m, zst, 'zst')), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await hook(stopInput(m, main, 'main'), { WYBE_CONNECT_DISTIL: 'r-1' }), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(D.pendingView(p), []);
  const q = connect(m, 'http://127.0.0.1:9', ['sessions:full']);
  assert.deepEqual(await hook(stopInput(m, main, 'other')), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(D.pendingView(q), []);
  const bad = await runNode(join(HOOKS, 'flush.js'), { input: null, env: envOf(m) });
  assert.equal(bad.code, 0);
});

test('Codex SessionEnd (--offline, within Codex\'s 3 s cap) only notes: no run starts from it', async () => {
  const m = machine();
  const p = connect(m, 'http://127.0.0.1:9');
  const sid = '0190c0de-0000-7000-8000-0000000000e1';
  const a = m.rollout(sid);
  const log = join(m.dir, 'fake.log');
  const r = await runNode(join(HOOKS, 'flush.js'), { input: { session_id: sid, transcript_path: a, cwd: m.project, hook_event_name: 'SessionEnd', reason: 'other' }, env: envOf(m, { FAKE_LOG: log }) });
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(D.pendingView(p).map((x) => x.path), [a]);
  assert.equal(D.loadState(p).running, null);
  await sleep(500);
  assert.deepEqual(logLines(log), []);
});

test('first connect: the node\'s import request reaches the plugin\'s server, and one import distils every Codex session once, the distil run\'s own never', async () => {
  const m = machine();
  const node = await httpNode();
  let proxy = null;
  try {
    const p = connect(m, node.base);
    const T = Date.now();
    // The session the person connected from: its Stop hook ran before the node asked for the import.
    const sidA = '0190c0de-0000-7000-8000-0000000000f1';
    const a = m.rollout(sidA);
    // Earlier work, from before the plugin: never hooked.
    const b = m.rollout('0190c0de-0000-7000-8000-0000000000f2', { day: '12' });
    utimesSync(b, new Date(T - 5 * DAY), new Date(T - 5 * DAY));
    const old = m.rollout('0190c0de-0000-7000-8000-0000000000f3', { day: '01' });
    utimesSync(old, new Date(T - 40 * DAY), new Date(T - 40 * DAY));
    const sub = m.rollout('0190c0de-0000-7000-8000-0000000000f4', { source: { subagent: 'review' } });
    const own = m.rollout('0190c0de-0000-7000-8000-0000000000f5', { source: 'exec', prompt: 'wybe-connect distil run (started in the background by the wybe-connect plugin, not by a person).\nmode: import' });
    const before = rolloutsUnder(m.codexHome);
    const log = join(m.dir, 'fake.log');

    const r = await runNode(join(HOOKS, 'flush.js'), { input: stopInput(m, a, sidA), env: envOf(m, { FAKE_LOG: log }) });
    assert.equal(r.code, 0);
    assert.ok(await waitFor(() => D.loadState(p).lastSuccessAt));

    const at = new Date(T).toISOString();
    node.requestImport(at);
    // Codex starts the plugin's MCP server (mcp.json) with the session; it asks the node at once.
    proxy = spawn(process.execPath, [join(PKG, 'bin', 'mcp-proxy.js')], { env: envOf(m, { FAKE_LOG: log }), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '0' } } })}\n`);
    const s = await waitFor(() => { const x = D.loadState(p); return x.importHandled === at && !x.outbox && !x.running ? x : null; }, 30000);
    assert.ok(s, 'the import ran and was delivered by itself');
    assert.equal(s.lastError, null, 'the node confirmed the import');

    assert.deepEqual(twice(node.stored), [], 'every fact once');
    assert.equal(factsOf(node.stored, a).length, 6, 'the connect session: once, by its Stop');
    assert.equal(factsOf(node.stored, b).length, 6, 'the earlier session: by the import');
    for (const f of [old, sub, own]) assert.deepEqual(factsOf(node.stored, f), [], `${basename(f)} is not imported`);
    const runs = logLines(log);
    assert.equal(runs.length, 2, 'one ongoing run and one import run');
    assert.equal(runs[1].importOf, at);
    assert.deepEqual(rolloutsUnder(m.codexHome), before, 'the distil runs left no session of their own to import');
    assert.deepEqual([...new Set(node.calls)].sort(), ['pending_questions', 'remember']);
    for (const needle of PLANTED) assert.ok(!node.bodies.join('\n').includes(needle), `${needle} reached the node`);
  } finally {
    proxy?.kill();
    node.close();
  }
});

test('a sign-in finished through the server\'s connect tool asks the node for its import request at once', async () => {
  const m = machine();
  const node = await httpNode();
  try {
    node.requestImport('2026-10-26T11:00:00.000Z');
    const seen = [];
    const creds = { nodeUrl: node.base, resource: `${node.base}/mcp`, mcpEndpoint: `${node.base}/mcp`, issuer: 'http://127.0.0.1:9', tokenEndpoint: 'http://127.0.0.1:9/oauth/token', clientId: 'wybe-connect-codex', accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes: ['remember'] };
    const proxy = createProxy({
      root: m.codexRoot,
      env: {},
      clientName: 'wybe-connect (Codex)',
      connectImpl: async (_url, { onUrl }) => { onUrl('https://auth.example.invalid/authorize'); return creds; },
      onImportRequest: (at, paths) => seen.push({ at, connection: paths?.connection }),
    });
    const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect', arguments: { node_url: node.base } } });
    assert.ok(r.result);
    assert.ok(await waitFor(() => seen.length, 5000), 'the import request was seen without waiting for the 5-minute poll');
    assert.equal(seen[0].at, '2026-10-26T11:00:00.000Z');
    assert.equal(seen[0].connection, C.defaultConnection(m.codexRoot));
  } finally {
    node.close();
  }
});

// ------------------------------------------------------------------ the plugin's files
test('the Codex plugin ships its stdio MCP server in mcp.json, and the manual config.toml entry starts the same server', () => {
  const mcp = JSON.parse(readFileSync(join(PKG, 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['wybe']);
  assert.equal(mcp.mcpServers.wybe.type, 'stdio');
  assert.equal(mcp.mcpServers.wybe.command, 'node');
  assert.deepEqual(mcp.mcpServers.wybe.args, ['${PLUGIN_ROOT}/bin/mcp-proxy.js']);
  for (const f of ['bin/mcp-proxy.js', 'bin/distil-run.js']) assert.ok(existsSync(join(PKG, f)), `${f} missing`);
  const toml = readFileSync(join(PKG, 'config.toml.snippet'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.wybe\]\ncommand = "node"\nargs = \[".+\/bin\/mcp-proxy\.js"\]$/m);
  assert.doesNotMatch(toml, /codex mcp (add|login)/, 'no second sign-in through Codex\'s own OAuth');
  const manifest = JSON.parse(readFileSync(join(PKG, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.doesNotMatch(manifest.description, /delta/i);
  assert.match(manifest.description, /distil/i);
  const connect = readFileSync(join(PKG, 'bin', 'connect.js'), 'utf8');
  assert.doesNotMatch(connect, /codex mcp (add|login)/);
});
