import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { STANDING_INSTRUCTION } from '../lib/session-context.js';
import { followupFor, recordOf, FOLLOWUP_MARKER } from '../lib/cursor-spool.js';
import { gitBranch } from '../lib/transcript.js';
import { paths as pathsOf } from '../lib/home.js';

// Spawns packages/cursor/hooks/on-event.js once per hook payload in test/fixtures/cursor-hooks.jsonl,
// whose shapes follow https://cursor.com/docs/agent/hooks (read 2026-09-29). Not a live Cursor run.

const ROOT = join(import.meta.dirname, '..');
const PKG = join(ROOT, 'packages', 'cursor');
const SCRIPT = join(PKG, 'hooks', 'on-event.js');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'cursor-hooks.jsonl');
const TOKEN = ['wat_', 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');
const REFUSED = 'http://127.0.0.1:9';
const CONV = 'c0ffee00-1111-4222-8333-444455556666';
const NEVER = ['PLANTED-THINKING', 'PLANTED-EDIT-OLD', 'PLANTED-EDIT-NEW', 'PLANTED-ATTACHMENT', 'PLANTED-FOLLOWUP', 'Pl4nted-Pw'];
const FULL_ONLY = ['PLANTED-ASSISTANT-SENTENCE', 'PLANTED-TOOL-OUTPUT'];

function run(input, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, WYBE_CONNECT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-cursor-'));
  const home = join(dir, 'home');
  const project = join(dir, 'atlas-demo').replace(/\\/g, '/');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.git', 'config'), '[remote "origin"]\n\turl = https://example.com/x.git\n');
  writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/feat/retry\n');
  const events = readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l.replaceAll('{{PROJECT}}', project)));
  return { home, cursorHome: join(home, 'cursor'), project, events };
}

function writeCredentials(dir, endpointBase, scopes) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
    version: 1, nodeUrl: endpointBase, mcpEndpoint: `${endpointBase}/mcp`, issuer: REFUSED, tokenEndpoint: `${REFUSED}/oauth/token`,
    clientId: 'c-cursor', accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes,
  }));
}

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
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { open_questions: [{ id: 'q-11', text: 'Hva bruker du Cursor mest til?' }] } } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

test('cursor LIGHT: every hook answers in its documented shape; the spool on disk never holds a reply, tool I/O or the raw DSN', async () => {
  const { home, cursorHome, project, events } = sandbox();
  writeCredentials(cursorHome, REFUSED, ['remember', 'sessions:light']);
  const outputs = [];
  for (const e of events.slice(0, -1)) {
    const r = await run(e, home);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '', `${e.hook_event_name}: ${r.stderr}`);
    outputs.push([e.hook_event_name, JSON.parse(r.stdout)]);
  }
  assert.equal(outputs[0][0], 'sessionStart');
  assert.ok(outputs[0][1].additional_context.includes(STANDING_INSTRUCTION));
  assert.deepEqual(Object.keys(outputs[0][1]), ['additional_context']);
  for (const [name, out] of outputs.slice(1)) {
    assert.deepEqual(out, name === 'beforeSubmitPrompt' ? { continue: true } : {}, name);
  }
  const spoolText = readFileSync(join(cursorHome, 'spool', `${CONV}.jsonl`), 'utf8');
  for (const needle of [...NEVER, ...FULL_ONLY]) assert.ok(!spoolText.includes(needle), `${needle} was written to the light spool`);
  assert.ok(spoolText.includes('[REDACTED:url-userinfo]'), 'the spool is redacted before it is written');

  const stop = await run(events.at(-1), home);
  assert.equal(stop.code, 0);
  assert.deepEqual(JSON.parse(stop.stdout), {}, 'no questions cached, so no followup');
  assert.match(stop.stderr, /node not reachable \(network\); 1 delta\(s\) queued locally/);
  assert.ok(!stop.stderr.includes(TOKEN));
  assert.equal(existsSync(join(cursorHome, 'spool', `${CONV}.jsonl`)), false, 'the spool was consumed');
  assert.equal(existsSync(join(home, 'queue')), false, 'Claude Code\'s queue is not touched');

  const queued = readdirSync(join(cursorHome, 'queue'));
  assert.equal(queued.length, 1);
  const payload = JSON.parse(readFileSync(join(cursorHome, 'queue', queued[0]), 'utf8'));
  assert.deepEqual(Object.keys(payload), ['scope', 'harness', 'session_id', 'transcript_id', 'project', 'started_at', 'ended_at', 'duration_s', 'files_touched', 'prompts', 'counts', 'delta', 'redaction']);
  assert.equal(payload.harness, 'cursor');
  assert.equal(payload.scope, 'sessions:light');
  assert.equal(payload.session_id, CONV);
  assert.deepEqual(payload.project, { name: 'atlas-demo', git_remotes: ['origin'], branch: 'feat/retry' });
  assert.deepEqual(payload.files_touched, [`${project}/lib/queue.js`]);
  assert.deepEqual(payload.prompts.map((p) => p.text), [
    'Add a retry with backoff to the ingest queue, and use DATABASE_URL=postgres://[REDACTED:url-userinfo]@db.example.internal:5432/demo for the smoke test',
    'Also cap the retries at five.',
  ]);
  assert.deepEqual(payload.counts, { prompts: 2, assistant_turns: 0, tool_calls: 0 });
  assert.deepEqual(payload.delta, { seq: 1, event: 'stop', records: 3 });
  assert.deepEqual(payload.redaction, { families: [{ family: 'url-userinfo', count: 1 }] }, 'the spool pass counted once, the flush pass added nothing');
  const s = JSON.stringify(payload);
  for (const needle of [...NEVER, ...FULL_ONLY]) assert.ok(!s.includes(needle), `${needle} left the machine under sessions:light`);
});

test('cursor POSITIVE CONTROL under sessions:full: the reply and tool output are sent, the rest still never; then one guarded followup', async () => {
  const { home, cursorHome, events } = sandbox();
  const node = await fakeNodeServer();
  try {
    writeCredentials(cursorHome, node.base, ['sessions:full']);
    for (const e of events.slice(0, -1)) assert.equal((await run(e, home)).code, 0);
    const stop = await run(events.at(-1), home);
    assert.equal(stop.code, 0);
    assert.equal(stop.stderr, '');
    const calls = node.seen.filter((c) => c.rpc === 'tools/call');
    assert.equal(calls.length, 1);
    for (const c of node.seen) assert.equal(c.auth, `Bearer ${TOKEN}`);
    const session = calls[0].params.arguments.session;
    const s = JSON.stringify(session);
    for (const needle of FULL_ONLY) assert.ok(s.includes(needle), `${needle} must be present under sessions:full, or the light test proves nothing`);
    for (const needle of NEVER) assert.ok(!s.includes(needle), `${needle} left the machine under sessions:full`);
    assert.deepEqual(session.turns.map((t) => t.role), ['user', 'tool', 'assistant', 'user']);
    assert.equal(session.turns[1].tool.name, 'Shell');

    // the answer carried an open question: this stop already offers it, once
    const out = JSON.parse(stop.stdout);
    assert.deepEqual(Object.keys(out), ['followup_message']);
    assert.ok(out.followup_message.startsWith(FOLLOWUP_MARKER));
    assert.ok(out.followup_message.includes('Hva bruker du Cursor mest til?') && out.followup_message.includes('"q-11"'));
    assert.ok(!out.followup_message.includes(TOKEN));

    const again = await run(events.at(-1), home);
    assert.deepEqual(JSON.parse(again.stdout), {}, 'the same question is not put again within 14 days');
  } finally {
    node.server.close();
  }
});

test('cursor sessionEnd: the spool goes to the local queue without a single request', async () => {
  const { home, cursorHome, events } = sandbox();
  const node = await fakeNodeServer();
  try {
    writeCredentials(cursorHome, node.base, ['sessions:light']);
    await run(events[1], home);
    const end = await run({ conversation_id: CONV, session_id: CONV, hook_event_name: 'sessionEnd', reason: 'window_close', duration_ms: 1000, is_background_agent: false, final_status: 'completed' }, home);
    assert.deepEqual(end, { code: 0, stdout: '{}\n', stderr: '' });
    assert.equal(node.seen.length, 0);
    assert.equal(readdirSync(join(cursorHome, 'queue')).length, 1);
  } finally {
    node.server.close();
  }
});

test('cursor without a credential or a sessions scope: prompts are never blocked and nothing is spooled; bad stdin exits 0', async () => {
  const { home, cursorHome, events } = sandbox();
  const r = await run(events[1], home);
  assert.deepEqual(r, { code: 0, stdout: '{"continue":true}\n', stderr: '' });
  assert.equal(existsSync(join(cursorHome, 'spool')), false);
  assert.deepEqual(await run(events[0], home), { code: 0, stdout: '{}\n', stderr: '' });
  writeCredentials(cursorHome, REFUSED, ['remember', 'conversations']);
  assert.deepEqual(await run(events[1], home), { code: 0, stdout: '{"continue":true}\n', stderr: '' });
  assert.equal(existsSync(join(cursorHome, 'spool')), false);
  const stop = await run(events.at(-1), home);
  assert.deepEqual(stop, { code: 0, stdout: '{}\n', stderr: '' });
  const bad = await run('{not json', home);
  assert.equal(bad.code, 0);
  assert.equal(bad.stdout, '{}\n');
  assert.match(bad.stderr, /^wybe-connect: hook failed: /);
});

test('followupFor: only a completed, non-followup turn; one question at a time; 14-day backoff per question', () => {
  const home = mkdtempSync(join(tmpdir(), 'wybe-connect-followup-'));
  const p = pathsOf(home);
  mkdirSync(p.state, { recursive: true });
  writeFileSync(p.openQuestions, JSON.stringify({ open_questions: [{ id: 'a', text: 'First?' }, { id: 'b', text: 'Second?' }, { text: 'no id, never asked' }] }));
  const t0 = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(followupFor({ paths: p, status: 'aborted', loopCount: 0, now: t0 }), null);
  assert.equal(followupFor({ paths: p, status: 'completed', loopCount: 1, now: t0 }), null);
  assert.equal(followupFor({ paths: p, status: 'completed', loopCount: undefined, now: t0 }), null);
  assert.match(followupFor({ paths: p, status: 'completed', loopCount: 0, now: t0 }), /First\?/);
  assert.match(followupFor({ paths: p, status: 'completed', loopCount: 0, now: t0 + 1000 }), /Second\?/);
  assert.equal(followupFor({ paths: p, status: 'completed', loopCount: 0, now: t0 + 2000 }), null);
  assert.match(followupFor({ paths: p, status: 'completed', loopCount: 0, now: t0 + 15 * 24 * 3600 * 1000 }), /First\?/);
});

test('recordOf: the scope decides what is kept; the followup marker is never a prompt; thinking is never recorded', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const reply = { hook_event_name: 'afterAgentResponse', text: 'x', workspace_roots: ['/w'] };
  assert.equal(recordOf(reply, 'sessions:light', now), null);
  assert.equal(recordOf(reply, 'sessions:full', now).kind, 'assistant-text');
  assert.equal(recordOf({ hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: {}, tool_output: 'o' }, 'sessions:light', now), null);
  assert.equal(recordOf({ hook_event_name: 'beforeSubmitPrompt', prompt: `${FOLLOWUP_MARKER} ask` }, 'sessions:full', now), null);
  assert.equal(recordOf({ hook_event_name: 'afterAgentThought', text: 'hmm' }, 'sessions:full', now), null);
  const big = recordOf({ hook_event_name: 'postToolUse', tool_name: 'Read', tool_input: { p: 'y'.repeat(9000) }, tool_output: 'z'.repeat(9000) }, 'sessions:full', now);
  assert.ok(big.output.length < 4100 && JSON.stringify(big.input).length < 4200, 'tool I/O is clipped before it is spooled');
});

test('cursor hooks.json: the seven hooks on one script, stop loop_limit 1, no afterAgentThought; the manual example matches it', () => {
  const plugin = JSON.parse(readFileSync(join(PKG, 'hooks', 'hooks.json'), 'utf8'));
  const manual = JSON.parse(readFileSync(join(PKG, 'hooks.user.example.json'), 'utf8'));
  assert.equal(plugin.version, 1);
  const events = ['afterAgentResponse', 'afterFileEdit', 'beforeSubmitPrompt', 'postToolUse', 'sessionEnd', 'sessionStart', 'stop'];
  assert.deepEqual(Object.keys(plugin.hooks).sort(), events);
  for (const [event, list] of Object.entries(plugin.hooks)) {
    assert.equal(list.length, 1);
    assert.equal(list[0].command, 'node "${CURSOR_PLUGIN_ROOT}/hooks/on-event.js"', event);
    const m = manual.hooks[event][0];
    assert.equal(m.command, 'node "/ABSOLUTE/PATH/TO/wybe-connect/packages/cursor/hooks/on-event.js"', event);
    assert.deepEqual({ ...m, command: null }, { ...list[0], command: null }, `${event}: the manual example drifted`);
  }
  assert.equal(plugin.hooks.stop[0].loop_limit, 1);
  assert.ok(existsSync(SCRIPT));
});

test('cursor plugin: manifest, root marketplace listing, mcp.json entry; gitBranch reads HEAD', () => {
  const manifest = JSON.parse(readFileSync(join(PKG, '.cursor-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'wybe-connect');
  assert.equal(manifest.hooks, './hooks/hooks.json');
  assert.ok(existsSync(join(PKG, 'skills', 'connect', 'SKILL.md')));
  const market = JSON.parse(readFileSync(join(ROOT, '.cursor-plugin', 'marketplace.json'), 'utf8'));
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['wybe-connect', 'packages/cursor']]);
  assert.deepEqual(JSON.parse(readFileSync(join(PKG, 'mcp.json.snippet'), 'utf8')), { mcpServers: { wybe: { url: 'https://dittfirma.wybe.me/mcp' } } });

  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-head-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
  assert.equal(gitBranch(dir), 'feat/x');
  writeFileSync(join(dir, '.git', 'HEAD'), 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00\n');
  assert.equal(gitBranch(dir), null, 'detached');
  assert.equal(gitBranch(join(dir, 'nope')), null);
});
