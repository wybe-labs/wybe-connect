// The plugin's MCP server and `connect use <name> --session <id>`: the host gives an MCP server no session
// id, so the tools take one (session_id, from the SessionStart note) and each call resolves that session's
// connection then. Once any session has been moved, a call without one is refused, never sent to the
// default. A host-given session id would replace the parameter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProxy } from '../lib/mcp-proxy.js';
import { removeConnection, saveConnection, sessionNote, sessionPaths, useConnection } from '../lib/connections.js';

const A = 'https://node-a.example.invalid';
const B = 'https://node-b.example.invalid';
const TOK_A = ['wat_', 'a'.repeat(40)].join('');
const TOK_B = ['wat_', 'b'.repeat(40)].join('');
const grant = (node, tok) => ({ version: 1, nodeUrl: node, resource: `${node}/mcp`, mcpEndpoint: `${node}/mcp`, issuer: 'https://auth.example.invalid', tokenEndpoint: 'https://auth.example.invalid/token', clientId: 'wybe-connect-claude-code', accessToken: tok, refreshToken: null, expiresAt: null, scopes: ['remember'] });
const req = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const remember = (id, sessionId) => req(id, 'tools/call', { name: 'remember', arguments: { items: [{ content: `a fact ${id}` }], ...(sessionId ? { session_id: sessionId } : {}) } });

function recordingNode() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    const msg = JSON.parse(init.body);
    const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    calls.push({ url: String(url), rpc: msg.method, args: msg.params?.arguments });
    if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remember', inputSchema: { type: 'object', properties: { items: { type: 'array' } } } }] } });
    return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
  };
  return { calls, fetchImpl };
}

function twoConnections() {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-session-'));
  saveConnection(root, grant(A, TOK_A));
  saveConnection(root, grant(B, TOK_B));
  useConnection(root, 'node-a.example.invalid'); // A is the default
  return root;
}
const sentTo = (node) => node.calls.filter((c) => c.rpc === 'tools/call').map((c) => c.url);

test('two sessions in one folder, moved to A and B: each remember lands on its own session\'s node; the session_id stays here', async () => {
  const root = twoConnections();
  useConnection(root, 'node-a.example.invalid', { sessionId: 'sess-one' });
  useConnection(root, 'node-b.example.invalid', { sessionId: 'sess-two' });
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  await proxy.handle(remember(1, 'sess-two'));
  await proxy.handle(remember(2, 'sess-one'));
  assert.deepEqual(sentTo(node), [`${B}/mcp`, `${A}/mcp`]);
  assert.ok(node.calls.every((c) => !c.args || !('session_id' in c.args)), 'the session id stays on this machine');
});

test('a session moved after the server started: its next remember goes to the node it was moved to', async () => {
  const root = twoConnections();
  useConnection(root, 'node-a.example.invalid', { sessionId: 'sess-one' });
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  await proxy.handle(remember(1, 'sess-one'));
  useConnection(root, 'node-b.example.invalid', { sessionId: 'sess-one' });
  await proxy.handle(remember(2, 'sess-one'));
  assert.deepEqual(sentTo(node), [`${A}/mcp`, `${B}/mcp`]);
});

test('once a session has been moved, a call without session_id is refused and reaches no node', async () => {
  const root = twoConnections();
  useConnection(root, 'node-b.example.invalid', { sessionId: 'sess-two' });
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  const r = await proxy.handle(remember(1, null));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /session_id/);
  assert.deepEqual(sentTo(node), []);
});

// A move to a connection that was later removed must not leave every new session refused for good, and a
// session opened with one connection must still learn its id. Only a moved session that could be sent elsewhere refuses.
test('a session moved to a connection that was then removed: a new session without session_id goes to the default', async () => {
  const root = twoConnections();
  useConnection(root, 'node-b.example.invalid', { sessionId: 'sess-old' });
  removeConnection(root, 'node-b.example.invalid');
  sessionPaths(root, { sessionId: 'sess-new', env: {} });
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  const r = await proxy.handle(remember(1, null));
  assert.notEqual(r.result.isError, true, r.result.content?.[0]?.text);
  assert.deepEqual(sentTo(node), [`${A}/mcp`]);
});

test('a session moved to a connection that was removed and then added again: a session opened meanwhile is not locked out', async () => {
  const root = twoConnections();
  useConnection(root, 'node-b.example.invalid', { sessionId: 'sess-old' });
  removeConnection(root, 'node-b.example.invalid');
  sessionPaths(root, { sessionId: 'sess-new', env: {} });
  saveConnection(root, grant(B, TOK_B));
  useConnection(root, 'node-a.example.invalid');
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  const r = await proxy.handle(remember(1, null));
  assert.notEqual(r.result.isError, true, r.result.content?.[0]?.text);
  assert.deepEqual(sentTo(node), [`${A}/mcp`]);
  // Positive control: a session moved to B after the re-add is again told apart.
  useConnection(root, 'node-b.example.invalid', { sessionId: 'sess-later' });
  assert.equal((await proxy.handle(remember(2, null))).result.isError, true);
});

test('a session opened with one connection is told its id, so it still works once another session is moved elsewhere', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-session-'));
  saveConnection(root, grant(A, TOK_A));
  const key = sessionPaths(root, { sessionId: 'sess-t', env: {} }).connection;
  const note = sessionNote(root, key, { sessionId: 'sess-t', command: 'connect' });
  assert.match(note ?? '', /sess-t/);
  saveConnection(root, grant(B, TOK_B));
  useConnection(root, 'node-a.example.invalid');
  useConnection(root, 'node-b.example.invalid', { sessionId: 'sess-v' });
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  const r = await proxy.handle(remember(1, 'sess-t'));
  assert.notEqual(r.result.isError, true, r.result.content?.[0]?.text);
  assert.deepEqual(sentTo(node), [`${A}/mcp`]);
});

test('a session moved to the default connection: a call without session_id goes there, nothing to tell apart', async () => {
  const root = twoConnections();
  useConnection(root, 'node-a.example.invalid', { sessionId: 'sess-one' });
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  await proxy.handle(remember(1, null));
  assert.deepEqual(sentTo(node), [`${A}/mcp`]);
});

test('after a move elsewhere, a session_id no session on this machine has is refused and reaches no node', async () => {
  const root = twoConnections();
  useConnection(root, 'node-b.example.invalid', { sessionId: 'sess-two' });
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  const r = await proxy.handle(remember(1, 'sess-two-typo'));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /session_id/);
  assert.deepEqual(sentTo(node), []);
});

test('no session moved: a call without session_id goes to the default, as before; tools/list offers session_id', async () => {
  const root = twoConnections();
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  await proxy.handle(remember(1, null));
  assert.deepEqual(sentTo(node), [`${A}/mcp`]);
  const list = await proxy.handle(req(2, 'tools/list'));
  const tool = list.result.tools.find((t) => t.name === 'remember');
  assert.equal(tool.inputSchema.properties.session_id.type, 'string');
});
