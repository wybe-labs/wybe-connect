import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createProxy, CONNECT_TOOL } from '../lib/mcp-proxy.js';
import { paths, saveCredentials, loadCredentials } from '../lib/home.js';
import { distilPaths } from '../lib/distil.js';
import { readRecords } from '../lib/ledger.js';

const NODE = 'https://demo.wybe.me';
const TOKEN_ENDPOINT = 'https://auth.wybe.me/oauth/token';
const OLD = ['wat_', 'o'.repeat(40)].join('');
const NEW = ['wat_', 'n'.repeat(40)].join('');

const home = () => paths(mkdtempSync(join(tmpdir(), 'wybe-connect-proxy-')));
const creds = (over = {}) => ({ nodeUrl: NODE, resource: `${NODE}/mcp`, mcpEndpoint: `${NODE}/mcp`, issuer: 'https://auth.wybe.me', tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c1', accessToken: OLD, refreshToken: 'wrt_r', expiresAt: null, scopes: ['remember', 'sessions:light'], ...over });
const req = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake node /mcp: accepts `valid` as the bearer, lists two tools, answers remember with an open question. */
function fakeNode({ valid = OLD } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url) === TOKEN_ENDPOINT) {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      seen.push({ refresh: form });
      return json({ access_token: NEW, token_type: 'Bearer', expires_in: 3600, refresh_token: 'wrt_r2', scope: 'remember sessions:light' });
    }
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    if (init.headers?.authorization !== `Bearer ${valid}`) return new Response('', { status: 401 });
    const msg = JSON.parse(init.body);
    seen.push({ rpc: msg.method, auth: init.headers.authorization === `Bearer ${NEW}` ? 'new' : 'old', params: msg.params });
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, 200, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remember', inputSchema: { type: 'object' } }, { name: 'report_session', inputSchema: { type: 'object' } }] } });
    if (msg.method === 'tools/call') return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":true,"stored":1}' }], structuredContent: { open_questions: [{ id: 'q1', text: 'Hva jobber du med nå?' }] } } });
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
  };
  return { seen, fetchImpl };
}

test('not connected: only `connect` is listed, and any other tool says to connect first', async () => {
  const p = home();
  const proxy = createProxy({ paths: p, fetchImpl: async () => { throw new Error('no network expected'); } });
  const init = await proxy.handle(req(1, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(init.result.serverInfo.name, 'wybe');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } });
  assert.equal(await proxy.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await proxy.handle(req(2, 'tools/list'))).result.tools.map((t) => t.name), ['connect']);
  const r = await proxy.handle(req(3, 'tools/call', { name: 'remember', arguments: {} }));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Call `connect`/);
  assert.equal((await proxy.handle(req(4, 'nope'))).error.code, -32601);
});

test('connect: answers at once with the sign-in link, stores the grant when the browser flow ends, then says tools changed', async () => {
  const p = home();
  const notes = [];
  let finish;
  const connectImpl = (url, opts) => {
    assert.equal(url, NODE);
    assert.equal(opts.clientName, 'wybe-connect (Claude Code)');
    opts.onUrl('https://auth.wybe.me/oauth/authorize?client_id=c1&state=s');
    return new Promise((r) => { finish = () => r(creds()); });
  };
  const proxy = createProxy({ paths: p, connectImpl, notify: (m) => notes.push(m) });
  const first = await proxy.handle(req(1, 'tools/call', { name: 'connect', arguments: { node_url: `${NODE}/` } }));
  assert.match(first.result.content[0].text, /browser window is opening.*https:\/\/auth\.wybe\.me\/oauth\/authorize/s);
  assert.equal(loadCredentials(p), null, 'nothing stored before the sign-in completes');
  const waiting = await proxy.handle(req(2, 'tools/call', { name: 'connect', arguments: { node_url: NODE } }));
  assert.match(waiting.result.content[0].text, /Still waiting/);
  finish();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(loadCredentials(p).accessToken, OLD, 'the grant is stored where the hooks read it');
  assert.deepEqual(notes, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
  const done = await proxy.handle(req(3, 'tools/call', { name: 'connect', arguments: { node_url: NODE } }));
  assert.match(done.result.content[0].text, /Connected to https:\/\/demo\.wybe\.me \(scopes: remember, sessions:light\)/);
  assert.ok(!JSON.stringify([first, waiting, done]).includes(OLD), 'no token in any answer');
});

test('connect: a refused sign-in is reported once, then a retry starts fresh; a bad address is refused', async () => {
  const p = home();
  let calls = 0;
  const connectImpl = (_url, opts) => { calls += 1; opts.onUrl('https://auth.wybe.me/oauth/authorize?x'); return new Promise((_r, reject) => setTimeout(() => reject(new Error('authorization refused: access_denied')), 5)); };
  const proxy = createProxy({ paths: p, connectImpl });
  const a = await proxy.handle(req(1, 'tools/call', { name: 'connect', arguments: { node_url: NODE } }));
  assert.match(a.result.content[0].text, /browser window is opening/, 'the person refuses in the browser after the link was shown');
  await new Promise((r) => setTimeout(r, 30));
  const b = await proxy.handle(req(2, 'tools/call', { name: 'connect', arguments: { node_url: NODE } }));
  assert.match(b.result.content[0].text, /did not finish \(authorization refused: access_denied\)/);
  assert.equal(b.result.isError, true);
  await proxy.handle(req(3, 'tools/call', { name: 'connect', arguments: { node_url: NODE } }));
  assert.equal(calls, 2, 'the retry starts a new sign-in');
  const bad = await proxy.handle(req(4, 'tools/call', { name: 'connect', arguments: { node_url: 'dittfirma' } }));
  assert.equal(bad.result.isError, true);
});

test('connect: a node that cannot be discovered is reported at once', async () => {
  const proxy = createProxy({ paths: home(), connectImpl: () => Promise.reject(new Error('GET https://demo.wybe.me/.well-known/oauth-authorization-server -> HTTP 404')) });
  const r = await proxy.handle(req(1, 'tools/call', { name: 'connect', arguments: { node_url: NODE } }));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Could not start the sign-in: .*HTTP 404/);
});

test('connected: the node\'s tools are listed with connect, a call is forwarded verbatim, open questions are cached', async () => {
  const p = home();
  saveCredentials(creds(), p);
  const node = fakeNode();
  const proxy = createProxy({ paths: p, fetchImpl: node.fetchImpl });
  assert.deepEqual((await proxy.handle(req(1, 'tools/list'))).result.tools.map((t) => t.name), ['remember', 'report_session', 'connect']);
  const r = await proxy.handle(req(2, 'tools/call', { name: 'remember', arguments: { items: [{ content: 'x' }] } }));
  assert.equal(r.result.content[0].text, '{"ok":true,"stored":1}');
  assert.deepEqual(node.seen.filter((s) => s.rpc === 'tools/call')[0].params, { name: 'remember', arguments: { items: [{ content: 'x' }] } });
  assert.equal(JSON.parse(readFileSync(p.openQuestions, 'utf8')).open_questions[0].id, 'q1');
});

test('connected: a 401 refreshes once for the stored resource, stores the new grant and retries', async () => {
  const p = home();
  saveCredentials(creds(), p);
  const node = fakeNode({ valid: NEW });
  const proxy = createProxy({ paths: p, fetchImpl: node.fetchImpl });
  const r = await proxy.handle(req(1, 'tools/call', { name: 'remember', arguments: {} }));
  assert.equal(r.result.content[0].text, '{"ok":true,"stored":1}');
  assert.equal(node.seen.find((s) => s.refresh).refresh.resource, `${NODE}/mcp`);
  assert.equal(loadCredentials(p).accessToken, NEW);
  assert.ok(node.seen.filter((s) => s.rpc === 'tools/call').every((s) => s.auth === 'new'));
});

test('the plugin ships the server: .mcp.json starts bin/mcp-proxy.js, which speaks stdio JSON-RPC', async () => {
  const pkg = join(import.meta.dirname, '..', 'packages', 'claude-code');
  const mcp = JSON.parse(readFileSync(join(pkg, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.wybe, { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/mcp-proxy.js'] });
  assert.ok(existsSync(join(pkg, 'bin', 'mcp-proxy.js')));
  const child = spawn(process.execPath, [join(pkg, 'bin', 'mcp-proxy.js')], { env: { ...process.env, WYBE_CONNECT_HOME: mkdtempSync(join(tmpdir(), 'wybe-connect-stdio-')) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  child.stdin.write(`${JSON.stringify(req(1, 'initialize', { protocolVersion: '2025-06-18' }))}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify(req(2, 'tools/list'))}\n`);
  for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  child.kill();
  const answers = lines.map((l) => JSON.parse(l));
  assert.equal(answers.length, 2, 'one answer per request, none for the notification');
  assert.equal(answers[0].result.serverInfo.name, 'wybe');
  assert.deepEqual(answers[1].result.tools, [CONNECT_TOOL]);
});

test('distil run: the tools are fixed whatever the node or sign-in, remember goes to the outbox redacted, never to the node', async () => {
  const p = home();
  const proxy = createProxy({ paths: p, distilRun: 'r-test-1', fetchImpl: async () => { throw new Error('no network expected'); } });
  assert.deepEqual((await proxy.handle(req(1, 'tools/list'))).result.tools.map((t) => t.name), ['remember', 'distil_done', 'pending_questions']);
  const planted = ['postgres://app:', 'Pl4nted-Pw', '@db.example.test/x'].join('');
  const r = await proxy.handle(req(2, 'tools/call', { name: 'remember', arguments: { items: [{ content: `Moved the app to ${planted}`, subject: 'project', extra: 'dropped' }], import_of: '2026-10-21T10:00:00.000Z', nope: 1 } }));
  assert.match(r.result.content[0].text, /Queued 1 item\(s\) as call 1/);
  const bad = await proxy.handle(req(3, 'tools/call', { name: 'remember', arguments: { items: [] } }));
  assert.equal(bad.result.isError, true);
  const q = await proxy.handle(req(4, 'tools/call', { name: 'pending_questions', arguments: {} }));
  assert.equal(q.result.content[0].text, '{"ok":true,"open_questions":[]}', 'not signed in: no questions, no error');
  assert.match((await proxy.handle(req(5, 'tools/call', { name: 'distil_done', arguments: {} }))).result.content[0].text, /1 remember call/);
  const late = await proxy.handle(req(6, 'tools/call', { name: 'remember', arguments: { items: [{ content: 'late' }] } }));
  assert.equal(late.result.isError, true, 'nothing joins an outbox after distil_done');
  const { records, torn } = readRecords(distilPaths(p).outbox('r-test-1'));
  assert.equal(torn, 0);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].args, { items: [{ content: 'Moved the app to postgres://[REDACTED:url-userinfo]@db.example.test/x', subject: 'project' }], import_of: '2026-10-21T10:00:00.000Z' });
  assert.deepEqual(records[1], { kind: 'done', items: 1 });
});

test('import: a node answer carrying import_request is handed on, and pollImport is one pending_questions call', async () => {
  const p = home();
  saveCredentials(creds(), p);
  const seen = [];
  const at = '2026-10-21T10:00:00.000Z';
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, 200, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    seen.push(msg.params?.name);
    return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, open_questions: [], import_request: { requested_at: at } }) }] } });
  };
  const handed = [];
  const proxy = createProxy({ paths: p, fetchImpl, onImportRequest: (x) => handed.push(x) });
  await proxy.handle(req(1, 'tools/call', { name: 'remember', arguments: { items: [{ content: 'x' }] } }));
  assert.equal(await proxy.pollImport(), at);
  assert.deepEqual(seen, ['remember', 'pending_questions']);
  assert.deepEqual(handed, [at, at]);
});

// ------------------------------------------------------------------ several connections (lib/connections.js)
const { connectionNames, connectionPaths, defaultConnection, saveConnection, useConnection } = await import('../lib/connections.js');
const A = 'https://node-a.example.invalid';
const B = 'https://node-b.example.invalid';
const TOK_A = ['wat_', 'a'.repeat(40)].join('');
const TOK_B = ['wat_', 'b'.repeat(40)].join('');
const at = (node, over = {}) => creds({ nodeUrl: node, resource: `${node}/mcp`, mcpEndpoint: `${node}/mcp`, ...over });

/** A node fake that takes any bearer and records which one each tools/call carried, and to where. */
function anyBearerNode() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, 200, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    calls.push({ url: String(url), auth: init.headers.authorization, rpc: msg.method });
    if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remember', inputSchema: { type: 'object' } }] } });
    return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":true,"stored":1}' }], structuredContent: { open_questions: [{ id: 'q1', question: 'Hva jobber du med nå?' }] } } });
  };
  return { calls, fetchImpl };
}

const remember = (id) => req(id, 'tools/call', { name: 'remember', arguments: { items: [{ content: 'x' }] } });

test('connections: the server\'s connect stores a connection of its own with a grantId, makes it the default, and the tools use it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-proxy-conn-'));
  const node = anyBearerNode();
  const notes = [];
  const proxy = createProxy({ root, env: {}, notify: (m) => notes.push(m), fetchImpl: node.fetchImpl, connectImpl: (_url, opts) => { opts.onUrl('https://auth.example.invalid/authorize?x'); return Promise.resolve(at(A, { accessToken: TOK_A })); } });
  assert.deepEqual((await proxy.handle(req(1, 'tools/list'))).result.tools.map((t) => t.name), ['connect']);
  await proxy.handle(req(2, 'tools/call', { name: 'connect', arguments: { node_url: A } }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(connectionNames(root), ['node-a.example.invalid']);
  assert.equal(defaultConnection(root), 'node-a.example.invalid');
  const stored = loadCredentials(connectionPaths(root, 'node-a.example.invalid'));
  assert.match(stored.grantId, /^[0-9a-f]{32}$/);
  assert.equal(existsSync(join(root, 'credentials.json')), false, 'not the single layout');
  assert.deepEqual(notes, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
  assert.equal((await proxy.handle(remember(3))).result.content[0].text, '{"ok":true,"stored":1}');
  assert.deepEqual(node.calls.filter((c) => c.rpc === 'tools/call').map((c) => [c.url, c.auth]), [[`${A}/mcp`, `Bearer ${TOK_A}`]]);
  assert.ok(existsSync(connectionPaths(root, 'node-a.example.invalid').openQuestions), 'open questions cached for that connection');
});

test('connections: the server uses WYBE_CONNECT_NODE, else the default, keeps the connection it found, and an unknown name is no connection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-proxy-conn-'));
  saveConnection(root, at(A, { accessToken: TOK_A }));
  saveConnection(root, at(B, { accessToken: TOK_B })); // B is the default now
  const node = anyBearerNode();
  const named = createProxy({ root, env: { WYBE_CONNECT_NODE: 'node-a.example.invalid' }, fetchImpl: node.fetchImpl });
  const byDefault = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  await named.handle(remember(1));
  await byDefault.handle(remember(2));
  useConnection(root, 'node-a.example.invalid'); // the default moves; a running server keeps its own
  await byDefault.handle(remember(3));
  assert.deepEqual(node.calls.filter((c) => c.rpc === 'tools/call').map((c) => c.auth), [`Bearer ${TOK_A}`, `Bearer ${TOK_B}`, `Bearer ${TOK_B}`]);
  const unknown = createProxy({ root, env: { WYBE_CONNECT_NODE: 'node-c.example.invalid' }, fetchImpl: node.fetchImpl });
  assert.deepEqual((await unknown.handle(req(4, 'tools/list'))).result.tools.map((t) => t.name), ['connect'], 'never another node');
});

test('connections: a refresh never writes over a grant replaced while it ran', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-proxy-conn-'));
  const key = saveConnection(root, at(A));
  const replacement = ['wat_', 'r'.repeat(40)].join('');
  const node = fakeNode({ valid: NEW });
  const fetchImpl = async (url, init) => {
    if (String(url) === TOKEN_ENDPOINT) saveConnection(root, at(A, { accessToken: replacement })); // a sign-in again, meanwhile
    return node.fetchImpl(url, init);
  };
  const proxy = createProxy({ root, env: {}, fetchImpl });
  const r = await proxy.handle(remember(1));
  assert.equal(r.result.content[0].text, '{"ok":true,"stored":1}', 'this call still goes through with its refreshed token');
  assert.equal(loadCredentials(connectionPaths(root, key)).accessToken, replacement, 'the new grant stands');
});
