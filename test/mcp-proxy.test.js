import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createProxy, CONNECT_TOOL } from '../lib/mcp-proxy.js';
import { paths, saveCredentials, loadCredentials } from '../lib/home.js';

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

test('every forwarded argument is redacted on this machine first (planted DSN password and key never reach the node)', async () => {
  const p = home();
  saveCredentials(creds(), p);
  const node = fakeNode();
  const proxy = createProxy({ paths: p, fetchImpl: node.fetchImpl });
  const key = ['sk', 'ant', 'PLANTEDplantedPLANTEDplanted01'].join('-');
  const bait = `Prod-DB er postgres://app:Pl4nted-Pw-9x@db.internal:5432/x og nøkkelen ${key}`;
  await proxy.handle(req(1, 'tools/call', { name: 'remember', arguments: { items: [{ content: bait, subject: 'Infra' }] } }));
  const sent = JSON.stringify(node.seen.find((s) => s.rpc === 'tools/call').params);
  assert.ok(!sent.includes('Pl4nted-Pw-9x'), 'the DSN password left the machine');
  assert.ok(!sent.includes('PLANTEDplanted'), 'the API key left the machine');
  assert.ok(sent.includes('[REDACTED:url-userinfo]') && sent.includes('Prod-DB er postgres://'), 'the rest of the item is kept');
});

test('an import request in a node answer is handed on once per answer; pending_questions is the poll', async () => {
  const p = home();
  saveCredentials(creds(), p);
  const AT = '2026-10-21T11:59:00.000Z';
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    const msg = JSON.parse(init.body);
    seen.push(msg.method === 'tools/call' ? msg.params.name : msg.method);
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, 200, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, open_questions: [], import_request: { requested_at: AT } }) }] } });
  };
  const asked = [];
  const proxy = createProxy({ paths: p, fetchImpl, onImportRequest: (at) => asked.push(at) });
  await proxy.poll();
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'pending_questions'], 'the poll is one pending_questions call');
  assert.deepEqual(asked, [AT]);
  await proxy.handle(req(1, 'tools/call', { name: 'remember', arguments: { items: [] } }));
  assert.deepEqual(asked, [AT, AT], 'any answer carrying it hands it on; lib/distil.js runs each request once');
  const unconnected = createProxy({ paths: home(), fetchImpl, onImportRequest: (at) => asked.push(at) });
  assert.equal(await unconnected.poll(), null, 'not connected: no poll');
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
