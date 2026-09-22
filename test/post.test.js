import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, reportSession, openQuestionsOf, PROTOCOL_VERSION } from '../lib/post.js';

// Synthetic tokens, assembled at runtime (no secret-shaped literal in the repo).
const TOKEN = ['wat_', 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');
const FRESH = ['wat_', 'Zx0Cv9Bn8Mm7Ll6Kk5Jj4Hh3Gg2Ff1Dd0Ss9Aa8Qq'].join('');
const ENDPOINT = 'https://demo.wybe.me/mcp';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fake node: records every request, answers the MCP handshake and one tools/call. */
function fakeNode({ callAnswer, sse = false, statusFor = () => null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const rec = { url, method: init.method, headers: init.headers, body };
    calls.push(rec);
    const forced = statusFor(rec, calls.length);
    if (forced) return new Response('', { status: forced });
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    if (body.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'node' } } }, { headers: { 'mcp-session-id': 'sess-42' } });
    }
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (body.method === 'tools/call') {
      const msg = { jsonrpc: '2.0', id: body.id, result: callAnswer(body) };
      if (sse) {
        const text = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`;
        return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return jsonResponse(msg);
    }
    throw new Error(`fake node: unexpected method ${body.method}`);
  };
  return { calls, fetchImpl };
}

const okAnswer = () => ({ content: [{ type: 'text', text: 'stored' }], structuredContent: { stored: 1, open_questions: [{ id: 'q1', text: 'Hva bruker du Claude Code til?' }] } });

test('a tool call runs initialize -> initialized -> tools/call -> DELETE with the bearer and the session id', async () => {
  const node = fakeNode({ callAnswer: okAnswer });
  const r = await callTool({ endpoint: ENDPOINT, accessToken: TOKEN, name: 'report_session', args: { session: { scope: 'sessions:light' } }, fetchImpl: node.fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.openQuestions, [{ id: 'q1', text: 'Hva bruker du Claude Code til?' }]);
  assert.deepEqual(node.calls.map((c) => c.body?.method ?? c.method), ['initialize', 'notifications/initialized', 'tools/call', 'DELETE']);
  for (const c of node.calls) {
    assert.equal(c.url, ENDPOINT);
    assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers['mcp-protocol-version'], PROTOCOL_VERSION);
  }
  assert.equal(node.calls[0].headers.accept, 'application/json, text/event-stream');
  assert.equal(node.calls[0].headers['mcp-session-id'], undefined, 'no session before initialize answers');
  assert.equal(node.calls[1].headers['mcp-session-id'], 'sess-42');
  assert.equal(node.calls[2].headers['mcp-session-id'], 'sess-42');
  assert.equal(node.calls[3].headers['mcp-session-id'], 'sess-42');
  const call = node.calls[2].body;
  assert.deepEqual(Object.keys(call), ['jsonrpc', 'id', 'method', 'params']);
  assert.equal(call.jsonrpc, '2.0');
  assert.deepEqual(call.params, { name: 'report_session', arguments: { session: { scope: 'sessions:light' } } });
});

test('an SSE answer is read: the first JSON-RPC message with our id wins, notifications are skipped', async () => {
  const node = fakeNode({ callAnswer: okAnswer, sse: true });
  const r = await callTool({ endpoint: ENDPOINT, accessToken: TOKEN, name: 'report_session', args: {}, fetchImpl: node.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.openQuestions.length, 1);
});

test('401 is an auth outcome and stops before tools/call', async () => {
  const node = fakeNode({ callAnswer: okAnswer, statusFor: () => 401 });
  const r = await callTool({ endpoint: ENDPOINT, accessToken: TOKEN, name: 'x', args: {}, fetchImpl: node.fetchImpl });
  assert.deepEqual(r, { ok: false, kind: 'auth', status: 401, message: 'HTTP 401' });
  assert.equal(node.calls.length, 1);
});

test('a connection refused is a network outcome (real socket to 127.0.0.1:9)', async () => {
  const r = await callTool({ endpoint: 'http://127.0.0.1:9/mcp', accessToken: TOKEN, name: 'x', args: {}, timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'network');
  assert.ok(!r.message.includes(TOKEN));
});

test('a 5xx, a JSON-RPC error and a tool isError are server outcomes', async () => {
  const five = fakeNode({ callAnswer: okAnswer, statusFor: (rec) => (rec.body?.method === 'tools/call' ? 503 : null) });
  assert.equal((await callTool({ endpoint: ENDPOINT, accessToken: TOKEN, name: 'x', args: {}, fetchImpl: five.fetchImpl })).kind, 'server');

  const rpcErr = { calls: [], fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'scope sessions:light missing' } });
  } };
  const e = await callTool({ endpoint: ENDPOINT, accessToken: TOKEN, name: 'x', args: {}, fetchImpl: rpcErr.fetchImpl });
  assert.equal(e.kind, 'server');
  assert.match(e.message, /-32602/);

  const toolErr = fakeNode({ callAnswer: () => ({ isError: true, content: [{ type: 'text', text: 'refused' }] }) });
  const t = await callTool({ endpoint: ENDPOINT, accessToken: TOKEN, name: 'x', args: {}, fetchImpl: toolErr.fetchImpl });
  assert.deepEqual(t, { ok: false, kind: 'server', message: 'tool error: refused' });
});

test('a body without our id is a protocol outcome', async () => {
  const node = { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    return jsonResponse({ jsonrpc: '2.0', id: 999999, result: {} });
  } };
  const r = await callTool({ endpoint: ENDPOINT, accessToken: TOKEN, name: 'x', args: {}, fetchImpl: node.fetchImpl });
  assert.equal(r.kind, 'protocol');
});

test('reportSession: 401 -> one refresh -> retry succeeds with the fresh token', async () => {
  let refreshes = 0;
  const node = fakeNode({ callAnswer: okAnswer, statusFor: (rec) => (rec.headers.authorization === `Bearer ${TOKEN}` ? 401 : null) });
  const creds = { mcpEndpoint: ENDPOINT, accessToken: TOKEN, refreshToken: 'wrt_old' };
  const { outcome, credentials } = await reportSession({
    credentials: creds,
    session: { scope: 'sessions:light' },
    fetchImpl: node.fetchImpl,
    refresh: async () => { refreshes += 1; return { ...creds, accessToken: FRESH, refreshToken: 'wrt_new' }; },
  });
  assert.equal(outcome.ok, true);
  assert.equal(refreshes, 1);
  assert.equal(credentials.accessToken, FRESH);
  assert.equal(credentials.refreshToken, 'wrt_new');
  assert.equal(node.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(node.calls[1].headers.authorization, `Bearer ${FRESH}`);
});

test('reportSession: 401 and a refresh that fails leaves an auth outcome and the old credentials; still 401 after refresh is one refresh only', async () => {
  const node = fakeNode({ callAnswer: okAnswer, statusFor: () => 401 });
  const creds = { mcpEndpoint: ENDPOINT, accessToken: TOKEN, refreshToken: 'wrt_old' };
  const a = await reportSession({ credentials: creds, session: {}, fetchImpl: node.fetchImpl, refresh: async () => null });
  assert.equal(a.outcome.kind, 'auth');
  assert.equal(a.credentials, creds);
  let refreshes = 0;
  const b = await reportSession({ credentials: creds, session: {}, fetchImpl: node.fetchImpl, refresh: async () => { refreshes += 1; return { ...creds, accessToken: FRESH }; } });
  assert.equal(b.outcome.kind, 'auth');
  assert.equal(refreshes, 1);
});

test('reportSession: a network failure never triggers a refresh', async () => {
  let refreshes = 0;
  const fetchImpl = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const { outcome } = await reportSession({ credentials: { mcpEndpoint: ENDPOINT, accessToken: TOKEN }, session: {}, fetchImpl, refresh: async () => { refreshes += 1; return null; } });
  assert.deepEqual(outcome, { ok: false, kind: 'network', message: 'network: ECONNREFUSED' });
  assert.equal(refreshes, 0);
});

test('openQuestionsOf reads structuredContent, then JSON text, else nothing', () => {
  assert.deepEqual(openQuestionsOf({ structuredContent: { open_questions: [{ id: 1 }] } }), [{ id: 1 }]);
  assert.deepEqual(openQuestionsOf({ content: [{ type: 'text', text: JSON.stringify({ open_questions: [{ id: 2 }] }) }] }), [{ id: 2 }]);
  assert.deepEqual(openQuestionsOf({ content: [{ type: 'text', text: 'stored, thanks' }] }), []);
  assert.deepEqual(openQuestionsOf(undefined), []);
});

test('nothing is ever written to stdout/stderr/console by the poster (with a positive control on the capture)', async () => {
  const written = [];
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'].map((m) => [m, console[m]]);
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  for (const [m] of consoleMethods) console[m] = (...a) => written.push(a.join(' '));
  try {
    console.log('control-line');
    assert.deepEqual(written, ['control-line'], 'the capture itself must work');
    written.length = 0;
    const node = fakeNode({ callAnswer: okAnswer, statusFor: (rec, n) => (n === 1 ? 401 : null) });
    await reportSession({ credentials: { mcpEndpoint: ENDPOINT, accessToken: TOKEN }, session: {}, fetchImpl: node.fetchImpl, refresh: async (c) => ({ ...c, accessToken: FRESH }) });
    await callTool({ endpoint: 'http://127.0.0.1:9/mcp', accessToken: TOKEN, name: 'x', args: {}, timeoutMs: 5000 });
    assert.deepEqual(written, []);
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    for (const [m, fn] of consoleMethods) console[m] = fn;
  }
});
