// One rule for session pins (lib/connections.js): every session is told its id, including one opened before
// any connection existed; removing a connection never deletes a pin, a session moved to it is pinned to none;
// and a session pinned to none fails closed, never sent to the default or to a connection added again under
// the same name. Its calls say to choose one with `connect use <name>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProxy } from '../lib/mcp-proxy.js';
import { pinnedConnection, removeConnection, saveConnection, sessionNote, sessionPaths, useConnection } from '../lib/connections.js';

const N = (c) => `https://node-${c}.example.invalid`;
const H = (c) => `node-${c}.example.invalid`;
const tok = (c) => ['wat_', c.repeat(40)].join('');
const grant = (c) => ({ version: 1, nodeUrl: N(c), resource: `${N(c)}/mcp`, mcpEndpoint: `${N(c)}/mcp`, issuer: 'https://auth.example.invalid', tokenEndpoint: 'https://auth.example.invalid/token', clientId: 'wybe-connect-claude-code', accessToken: tok(c), refreshToken: null, expiresAt: null, scopes: ['remember'] });
const req = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const remember = (id, sid) => req(id, 'tools/call', { name: 'remember', arguments: { items: [{ content: `fact ${id}` }], ...(sid ? { session_id: sid } : {}) } });

function recordingNode() {
  const calls = [];
  const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    calls.push({ url: String(url), rpc: msg.method });
    if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remember', inputSchema: { type: 'object' } }] } });
    return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
  };
  return { calls, fetchImpl };
}
const sent = (n) => n.calls.filter((c) => c.rpc === 'tools/call').map((c) => c.url);
const home = () => mkdtempSync(join(tmpdir(), 'wybe-connect-pins-'));
// What a SessionStart hook does: pin, and always the note, connected or not.
const startSession = (root, sid) => {
  const p = sessionPaths(root, { sessionId: sid, env: {} });
  return { key: p.connection, note: sessionNote(root, p.connection, { sessionId: sid, command: 'connect' }) };
};
const hookNode = (root, sid) => sessionPaths(root, { sessionId: sid, env: {} }).connection;

const rows = {
  R3: async () => {
    // A move to a removed connection does not lock out a session opened meanwhile, with or without its id.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    useConnection(root, H('b'), { sessionId: 'sess-old' });
    removeConnection(root, H('b'));
    const T = startSession(root, 'sess-T');
    assert.match(T.note, /session_id is sess-T\b/);
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    await proxy.handle(remember(1, null));
    saveConnection(root, grant('b'));
    await proxy.handle(remember(2, null));
    await proxy.handle(remember(3, 'sess-T'));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('a')}/mcp`, `${N('a')}/mcp`]);
  },
  R3b: async () => {
    // A session opened with one connection is told its id and delivers naming it after another is moved to B.
    const root = home();
    saveConnection(root, grant('a'));
    const T = startSession(root, 'sess-T');
    assert.equal(T.note, 'This session sends to the connection node-a.example.invalid; its session_id is sess-T.');
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    startSession(root, 'sess-V');
    useConnection(root, H('b'), { sessionId: 'sess-V' });
    assert.equal((await proxy.handle(remember(2, null))).result.isError, true, 'without an id: refused');
    await proxy.handle(remember(3, 'sess-T'));
    await proxy.handle(remember(4, 'sess-V'));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('b')}/mcp`]);
  },
  R4a: async () => {
    // S moved to B, B removed: S is pinned to none (hooks and tools), never to the default A, and stays so when B comes back.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    assert.equal(hookNode(root, 'S'), H('a'));
    useConnection(root, H('b'), { sessionId: 'S' });
    useConnection(root, H('b'));
    assert.equal(hookNode(root, 'Q'), H('b'));
    useConnection(root, H('a'));
    removeConnection(root, H('b'));
    assert.equal(pinnedConnection(root, 'S'), null, 'the pin is kept, pinned to none');
    assert.equal(hookNode(root, 'Q'), null, 'control: a session opened on B stays unconnected');
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    const r = await proxy.handle(remember(1, 'S'));
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /connect use <name>/);
    assert.equal(hookNode(root, 'S'), null);
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    await proxy.handle(remember(2, 'S'));
    assert.equal(hookNode(root, 'S'), null, 'B added again: S is still pinned to none');
    assert.deepEqual(sent(node), []);
    assert.match(startSession(root, 'S').note, /connect use <name> --session S$/);
  },
  R4b: async () => {
    // S moved to "work" (node X); "work" removed and connected again to node Y: S sends nowhere, never to Y.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('x'), { name: 'work' });
    useConnection(root, H('a'));
    useConnection(root, 'work', { sessionId: 'S' });
    assert.equal(hookNode(root, 'S'), 'work');
    removeConnection(root, 'work');
    saveConnection(root, grant('y'), { name: 'work' });
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    const r = await proxy.handle(remember(1, 'S'));
    assert.match(r.result.content[0].text, /connect use <name>/);
    assert.equal(hookNode(root, 'S'), null);
    assert.deepEqual(sent(node), []);
    // Positive control: choosing a connection again moves S there.
    useConnection(root, 'work', { sessionId: 'S' });
    await proxy.handle(remember(2, 'S'));
    assert.deepEqual(sent(node), [`${N('y')}/mcp`]);
  },
  R4c: async () => {
    // A session opened before any connection (the first-run connect) is told its id, so a later move does not lock it out.
    const root = home();
    const T = startSession(root, 'sess-T');
    assert.equal(T.key, null);
    assert.match(T.note ?? '', /session_id is sess-T\b/);
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    saveConnection(root, grant('a'));
    assert.equal(hookNode(root, 'sess-T'), H('a'));
    await proxy.handle(req(0, 'tools/list'));
    await proxy.handle(remember(1, null));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    startSession(root, 'sess-V');
    useConnection(root, H('b'), { sessionId: 'sess-V' });
    assert.equal((await proxy.handle(remember(2, null))).result.isError, true, 'without an id: refused');
    await proxy.handle(remember(3, 'sess-T'));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('a')}/mcp`]);
  },
};

for (const [name, row] of Object.entries(rows)) test(`session pins ${name}`, row);

// R4c through the real hooks: each harness's SessionStart gives the id with no connection at all.
const ROOT = join(import.meta.dirname, '..');
function runHook(script, input, root) {
  return new Promise((resolve, reject) => {
    const base = { ...process.env };
    delete base.WYBE_CONNECT_NODE;
    const child = spawn(process.execPath, [join(ROOT, script)], { env: { ...base, WYBE_CONNECT_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
    child.stdin.end(JSON.stringify(input));
  });
}
const HOOKS = {
  'claude-code': ['packages/claude-code/hooks/session-start.js', { session_id: 'sess-first', hook_event_name: 'SessionStart', source: 'startup' }, (o) => o.hookSpecificOutput?.additionalContext],
  codex: ['packages/codex/hooks/session-start.js', { session_id: 'sess-first', hook_event_name: 'SessionStart', source: 'startup' }, (o) => o.hookSpecificOutput?.additionalContext],
  cursor: ['packages/cursor/hooks/on-event.js', { conversation_id: 'sess-first', hook_event_name: 'sessionStart' }, (o) => o.additional_context],
};
for (const [harness, [script, input, context]] of Object.entries(HOOKS)) {
  test(`session pins R4c, ${harness} hook: a session opened before any connection is told its id`, async () => {
    const out = await runHook(script, input, home());
    assert.equal(context(JSON.parse(out || '{}')), 'This session is not connected yet; its session_id is sess-first.');
  });
}
