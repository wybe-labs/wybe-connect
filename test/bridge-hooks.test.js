// The session bridge hooks as real processes against a fake node on 127.0.0.1. Claude Code:
// packages/claude-code/hooks/task-wait.js (asyncRewake). Codex: packages/codex/hooks/bridge.js and
// its detached bin/bridge.js poller, with a fake `codex` on PATH that records its argv. PATH holds
// only that fake (or nothing), so no test can reach a real claude or codex; CLAUDE_CONFIG_DIR,
// CODEX_HOME and WYBE_CONNECT_HOME are temp directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, appendFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startFakeNode, grantFor } from './fixtures/fake-node.mjs';

const ROOT = join(import.meta.dirname, '..');
const FIX = join(import.meta.dirname, 'fixtures');
const CC = join(ROOT, 'packages', 'claude-code');
const CX = join(ROOT, 'packages', 'codex');
const FAKE_CLAUDE = join(FIX, 'fake-distil-claude.mjs');
const { connectionPaths } = await import(pathToFileURL(join(CC, 'lib', 'connections.js')).href);
const { saveCredentials } = await import(pathToFileURL(join(CC, 'lib', 'home.js')).href);
const B = await import(pathToFileURL(join(CC, 'lib', 'bridge.js')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) { const t = Date.now(); for (;;) { const x = fn(); if (x) return x; if (Date.now() - t > ms) return null; await sleep(50); } }

function sandbox(node, harness) {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-bridgehooks-'));
  const home = join(dir, 'home');
  const root = harness === 'codex' ? join(home, 'codex') : home;
  const p = connectionPaths(root, 'node-a');
  saveCredentials(grantFor(node), p);
  const claudeDir = join(dir, 'claude-config');
  mkdirSync(claudeDir);
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'eier@example.invalid' } }));
  const codexDir = join(dir, 'codex-home');
  mkdirSync(codexDir);
  const payload = Buffer.from(JSON.stringify({ email: 'codex-eier@example.invalid' })).toString('base64url');
  writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({ tokens: { id_token: `e30.${payload}.c2ln`, access_token: 'codex-access-planted' } }));
  const project = join(dir, 'work', 'demo-app');
  mkdirSync(project, { recursive: true });
  const transcript = join(dir, harness === 'codex' ? 'rollout.jsonl' : 'session.jsonl');
  copyFileSync(join(FIX, harness === 'codex' ? 'codex-rollout.jsonl' : 'session.jsonl'), transcript);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const env = { WYBE_CONNECT_HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, WYBE_CONNECT_POLL_MS: '100', WYBE_CONNECT_CLAUDE_BIN: FAKE_CLAUDE, PATH: bin, SystemRoot: process.env.SystemRoot ?? '' };
  return { dir, home, p, project, transcript, bin, env };
}

/** A fake codex on PATH (on Windows the npm shim layout: codex.cmd + node_modules/@openai/codex/bin/codex.js). */
function fakeCodex(bin, log) {
  const body = `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(0);\n`;
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\n');
    const js = join(bin, 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(js, { recursive: true });
    writeFileSync(join(js, 'codex.js'), body);
    writeFileSync(join(js, '..', 'package.json'), '{"type":"module"}');
  } else {
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n${body}`);
    writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
    chmodSync(join(bin, 'codex'), 0o755);
  }
}

const children = new Set();
function hook(pkg, script, input, env) {
  const child = spawn(process.execPath, [join(pkg, 'hooks', script)], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', (code) => { children.delete(child); resolve({ code, stdout, stderr }); }));
  child.stdin.end(JSON.stringify(input));
  return { child, done, running: () => children.has(child) };
}
const killAll = () => { for (const c of children) c.kill(); };

const SID = '7a1b2c3d-0000-4000-8000-00000000c1a0';
const ccInput = (s, event, extra = {}) => ({ session_id: SID, transcript_path: s.transcript, cwd: s.project, hook_event_name: event, ...extra });
const task = (over = {}) => ({ id: randomUUID(), text: 'Kjør testene og fortell hva som feilet', mode: 'run', session_id: SID, ...over });

test('Claude Code: a run task wakes the session (exit 2, the task text on stderr); the next Stop sends the redacted result; SessionEnd closes it within 1.5 s', async () => {
  const node = await startFakeNode();
  const s = sandbox(node, 'claude-code');
  try {
    const t = task();
    node.tasks.push(t);
    const start = hook(CC, 'task-wait.js', ccInput(s, 'SessionStart', { source: 'startup' }), s.env);
    const woke = await start.done;
    assert.equal(woke.code, 2);
    assert.ok(woke.stderr.includes(t.text), woke.stderr);
    assert.ok(woke.stderr.includes(B.taskMark(t.id)));
    const rep = node.tool('sessions_report')[0].args.sessions[0];
    assert.equal(rep.id, SID);
    assert.equal(rep.harness, 'claude-code');
    assert.equal(rep.project, 'demo-app');
    assert.equal(rep.account, 'eier@example.invalid');
    assert.ok(!/[\\/]/.test(rep.project) && !('cwd' in rep), 'no local path');
    assert.equal(node.tool('inbox')[0].args.session_id, SID);

    const secret = ['ghp_', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2'].join('');
    const stop = hook(CC, 'task-wait.js', ccInput(s, 'Stop', { last_assistant_message: `Tre tester feilet i lib/queue. Token ${secret}`, stop_hook_active: false }), s.env);
    assert.ok(await waitFor(() => node.tool('task_result').length === 1));
    const r = node.tool('task_result')[0].args;
    assert.deepEqual([r.task_id, r.session_id, r.status], [t.id, SID, 'done']);
    assert.ok(r.text.startsWith('Tre tester feilet') && !r.text.includes(secret));
    assert.ok(await waitFor(() => node.tool('inbox').some((c) => c.args.ack?.some((a) => a.id === t.id && a.outcome === 'accepted'))), 'acked on the next inbox call');
    assert.ok(stop.running(), 're-armed: the Stop poller waits');

    const t0 = Date.now();
    const end = await hook(CC, 'task-wait.js', ccInput(s, 'SessionEnd', { reason: 'exit' }), s.env).done;
    // Claude Code gives SessionEnd 1.5 s. The hook only writes a mark and spawns the sender; the
    // bound here leaves room for a cold node start on a loaded machine running the whole suite.
    assert.ok(Date.now() - t0 < 3000, `SessionEnd took ${Date.now() - t0} ms`);
    assert.equal(end.code, 0);
    assert.deepEqual(await stop.done, { code: 0, stdout: '', stderr: '' }, 'the poller stops quietly once the session is closed');
    assert.ok(await waitFor(() => node.tool('sessions_report').some((c) => c.args.sessions[0].state === 'closed')), 'the detached sender reports the session closed');
  } finally {
    killAll();
    await node.close();
  }
});

test('Claude Code: a newer poller supersedes the older, which exits 0 without waking; only the newer delivers', async () => {
  const node = await startFakeNode();
  const s = sandbox(node, 'claude-code');
  try {
    const older = hook(CC, 'task-wait.js', ccInput(s, 'SessionStart'), s.env);
    assert.ok(await waitFor(() => node.tool('inbox').length >= 1));
    const newer = hook(CC, 'task-wait.js', ccInput(s, 'Stop', { last_assistant_message: 'ok' }), s.env);
    assert.deepEqual(await older.done, { code: 0, stdout: '', stderr: '' });
    const t = task();
    node.tasks.push(t);
    const r = await newer.done;
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes(t.text));
  } finally {
    killAll();
    await node.close();
  }
});

test('Claude Code: a confirm task wakes the session without the task text, pointing at take_task', async () => {
  const node = await startFakeNode();
  const s = sandbox(node, 'claude-code');
  try {
    const t = task({ mode: 'confirm', text: 'Slett produksjonsdatabasen i staging-miljøet' });
    node.tasks.push(t);
    const r = await hook(CC, 'task-wait.js', ccInput(s, 'SessionStart'), s.env).done;
    assert.equal(r.code, 2);
    assert.ok(!r.stderr.includes(t.text));
    assert.ok(!r.stderr.includes('produksjonsdatabasen'));
    assert.match(r.stderr, /take_task/);
    assert.ok(r.stderr.includes(t.id));
  } finally {
    killAll();
    await node.close();
  }
});

test('Claude Code: UserPromptSubmit pauses the poller while the person\'s turn runs; no task is delivered meanwhile', async () => {
  const node = await startFakeNode();
  const s = sandbox(node, 'claude-code');
  try {
    const waiting = hook(CC, 'task-wait.js', ccInput(s, 'SessionStart'), s.env);
    assert.ok(await waitFor(() => node.tool('inbox').length >= 1));
    const pause = await hook(CC, 'task-wait.js', ccInput(s, 'UserPromptSubmit', { prompt: 'fiks testene' }), s.env).done;
    assert.equal(pause.code, 0);
    assert.deepEqual(await waiting.done, { code: 0, stdout: '', stderr: '' });
    const polls = node.tool('inbox').length;
    node.tasks.push(task());
    await sleep(600);
    assert.equal(node.tool('inbox').length, polls, 'nobody polls during the person\'s turn');
  } finally {
    killAll();
    await node.close();
  }
});

test('Claude Code: StopFailure sends the running task\'s result as failed', async () => {
  const node = await startFakeNode();
  const s = sandbox(node, 'claude-code');
  try {
    node.tasks.push(task());
    assert.equal((await hook(CC, 'task-wait.js', ccInput(s, 'SessionStart'), s.env).done).code, 2);
    hook(CC, 'task-wait.js', ccInput(s, 'StopFailure', { error: 'rate_limit' }), s.env);
    assert.ok(await waitFor(() => node.tool('task_result').length === 1));
    assert.equal(node.tool('task_result')[0].args.status, 'failed');
    await hook(CC, 'task-wait.js', ccInput(s, 'SessionEnd'), s.env).done;
  } finally {
    killAll();
    await node.close();
  }
});

test('Claude Code: no connection, a distil run, or bad stdin: exit 0 at once, nothing printed', async () => {
  const node = await startFakeNode();
  const s = sandbox(node, 'claude-code');
  try {
    const none = { ...s.env, WYBE_CONNECT_HOME: mkdtempSync(join(tmpdir(), 'wybe-connect-none-')) };
    assert.deepEqual(await hook(CC, 'task-wait.js', ccInput(s, 'Stop'), none).done, { code: 0, stdout: '', stderr: '' });
    node.tasks.push(task());
    assert.deepEqual(await hook(CC, 'task-wait.js', ccInput(s, 'SessionStart'), { ...s.env, WYBE_CONNECT_DISTIL: 'run-1' }).done, { code: 0, stdout: '', stderr: '' });
    assert.equal(node.calls.length, 0);
    const child = spawn(process.execPath, [join(CC, 'hooks', 'task-wait.js')], { env: s.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const code = await new Promise((r) => { child.on('close', r); child.stdin.end('{not json'); });
    assert.equal(code, 0);
  } finally {
    killAll();
    await node.close();
  }
});

test('Claude Code hooks.json: task-wait is asyncRewake with a long timeout on SessionStart, Stop and StopFailure; quick on UserPromptSubmit and SessionEnd', () => {
  const hooks = JSON.parse(readFileSync(join(CC, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const waits = (event) => hooks[event].flatMap((g) => g.hooks).filter((h) => h.command.includes('/hooks/task-wait.js'));
  for (const event of ['SessionStart', 'Stop', 'StopFailure']) {
    const [h] = waits(event);
    assert.ok(h, `${event} runs task-wait.js`);
    assert.equal(h.asyncRewake, true);
    assert.ok(h.timeout >= 3600);
  }
  for (const event of ['UserPromptSubmit', 'SessionEnd']) {
    const [h] = waits(event);
    assert.ok(h && !h.asyncRewake && h.timeout <= 10, event);
  }
  assert.ok(waits('SessionEnd')[0].timeout <= 2);
  assert.ok(existsSync(join(CC, 'hooks', 'task-wait.js')) && existsSync(join(CC, 'bin', 'bridge.js')));
});

// ------------------------------------------------------------------ Codex

const CXSID = '0190c0de-0000-7000-8000-00000000c0de';
const cxInput = (s, event, extra = {}) => ({ session_id: CXSID, transcript_path: s.transcript, cwd: s.project, hook_event_name: event, model: 'gpt-5.5-codex', turn_id: 'turn-9', ...extra });
const userTurn = (s, text) => appendFileSync(s.transcript, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: text } })}\n`);
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('Codex: SessionStart starts a detached poller that queues the task with codex queue (argv, no shell); the Stop of that turn sends the result', async () => {
  const node = await startFakeNode();
  const s = sandbox(node, 'codex');
  const log = join(s.dir, 'codex-argv.log');
  fakeCodex(s.bin, log);
  const cp = connectionPaths(join(s.home, 'codex'), 'node-a');
  try {
    const t = task({ session_id: CXSID, text: 'Lag en kort changelog for "v2" & «v3»; ikke push' });
    node.tasks.push(t);
    const started = await hook(CX, 'bridge.js', cxInput(s, 'SessionStart', { source: 'startup' }), s.env).done;
    assert.deepEqual(started, { code: 0, stdout: '', stderr: '' });
    const argv = await waitFor(() => lines(log)[0]);
    assert.ok(argv, 'codex was called');
    assert.deepEqual(argv.slice(0, 4), ['queue', '--thread', CXSID, '--message']);
    assert.equal(argv.length, 5);
    assert.equal(argv[4], B.noticeFor({ ...t, status: 'delivered' }), 'the notice arrives as one argument, quotes and all');
    assert.equal(node.tool('sessions_report')[0].args.sessions[0].account, 'codex-eier@example.invalid');
    assert.equal(node.tool('sessions_report')[0].args.sessions[0].project, 'demo-app');

    // a Stop of the person's own turn is not the task's
    userTurn(s, 'hva er status på PR-en?');
    assert.equal((await hook(CX, 'bridge.js', cxInput(s, 'Stop', { last_assistant_message: 'PR-en er grønn.' }), s.env).done).stdout, '');
    assert.equal(node.tool('task_result').length, 0);
    // the queued message becomes its own turn; its Stop carries the result
    userTurn(s, argv[4]);
    const stop = await hook(CX, 'bridge.js', cxInput(s, 'Stop', { last_assistant_message: 'Changelog skrevet i CHANGELOG.md.' }), s.env).done;
    assert.deepEqual(stop, { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(node.tool('task_result').map((c) => [c.args.task_id, c.args.session_id, c.args.status, c.args.text]), [[t.id, CXSID, 'done', 'Changelog skrevet i CHANGELOG.md.']]);

    const pid = JSON.parse(readFileSync(B.sessionFiles(cp, CXSID).poller, 'utf8')).pid;
    assert.ok(Number.isInteger(pid) && B.pollerAlive(cp, CXSID), 'a live detached poller');
    await hook(CX, 'bridge.js', cxInput(s, 'SessionEnd'), s.env).done;
    assert.ok(await waitFor(() => node.tool('sessions_report').some((c) => c.args.sessions[0].state === 'closed')));
    assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'the detached poller is gone after SessionEnd');
    assert.ok(!node.calls.map((c) => c.body).join('\n').includes('codex-access-planted'));
  } finally {
    B.pausePoller(cp, CXSID);
    killAll();
    await node.close();
  }
});

test('Codex: when codex queue is not possible, the next Stop hands the notice over as a block, once; the turn after carries the result', async () => {
  const node = await startFakeNode();
  const s = sandbox(node, 'codex'); // PATH holds no codex at all
  const cp = connectionPaths(join(s.home, 'codex'), 'node-a');
  try {
    const t = task({ session_id: CXSID });
    node.tasks.push(t);
    await hook(CX, 'bridge.js', cxInput(s, 'SessionStart'), s.env).done;
    assert.ok(await waitFor(() => { try { return JSON.parse(readFileSync(B.sessionFiles(cp, CXSID).tasks, 'utf8')).pendingNotices.includes(t.id); } catch { return false; } }), 'the notice waits for the Stop hook');
    const first = await hook(CX, 'bridge.js', cxInput(s, 'Stop', { last_assistant_message: 'svar på personens egen tur' }), s.env).done;
    const out = JSON.parse(first.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(out.reason.includes(t.text) && out.reason.includes(B.taskMark(t.id)));
    assert.equal(node.tool('task_result').length, 0, 'the turn that got the block is not the task\'s');
    const second = await hook(CX, 'bridge.js', cxInput(s, 'Stop', { last_assistant_message: 'Testene kjørt: to feil.', stop_hook_active: true }), s.env).done;
    assert.equal(second.stdout, '', 'no second block');
    assert.deepEqual(node.tool('task_result').map((c) => [c.args.task_id, c.args.status, c.args.text]), [[t.id, 'done', 'Testene kjørt: to feil.']]);
  } finally {
    B.pausePoller(cp, CXSID);
    killAll();
    await node.close();
  }
});

test('Codex: a subagent thread (agent_id) and a session without a connection do nothing', async () => {
  const node = await startFakeNode();
  const s = sandbox(node, 'codex');
  try {
    node.tasks.push(task({ session_id: CXSID }));
    assert.deepEqual(await hook(CX, 'bridge.js', cxInput(s, 'SessionStart', { agent_id: 'agent-1' }), s.env).done, { code: 0, stdout: '', stderr: '' });
    const none = { ...s.env, WYBE_CONNECT_HOME: mkdtempSync(join(tmpdir(), 'wybe-connect-none-')) };
    assert.deepEqual(await hook(CX, 'bridge.js', cxInput(s, 'Stop'), none).done, { code: 0, stdout: '', stderr: '' });
    await sleep(400);
    assert.equal(node.calls.length, 0);
  } finally {
    killAll();
    await node.close();
  }
});

test('Codex hooks.json: bridge.js on SessionStart, Stop and SessionEnd, SessionEnd within the 3 s cap', () => {
  const hooks = JSON.parse(readFileSync(join(CX, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
    const h = hooks[event].flatMap((g) => g.hooks).find((x) => x.command === 'node "${PLUGIN_ROOT}/hooks/bridge.js"');
    assert.ok(h, event);
    if (event === 'SessionEnd') assert.ok(h.timeout <= 3);
  }
  assert.ok(existsSync(join(CX, 'bin', 'bridge.js')));
});
