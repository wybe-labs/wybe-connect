// One address can serve several colleagues: the colleague is chosen at sign-in and named in the access
// token. A connect to such an address signs in again (never renews), and each colleague gets a
// connection of its own on that address; the same colleague again replaces its own. An address whose
// tokens name no colleague renews as before. Every token here is fabricated and built at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { colleagueOf, STATIC_CLIENTS } from '../lib/oauth.js';
import { runConnect } from '../lib/connect-cli.js';
import { colleagueName, connectionNames, connectionPaths, checkedName, defaultConnection, findConnection, listConnections, pinnedConnection, saveConnection, sessionConnection, useConnection } from '../lib/connections.js';
import { harnessHome, loadCredentials, saveCredentials } from '../lib/home.js';
import { createProxy } from '../lib/mcp-proxy.js';
import { redact } from '../lib/redact.js';

const NODE = 'https://colleagues.example.invalid';
const HOST = 'colleagues.example.invalid';
const ISSUER = 'https://auth.example.invalid';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (colleague, n = 1) => [
  b64({ alg: 'EdDSA', typ: 'at+jwt', kid: 'k1' }),
  b64({ aud: `${NODE}/mcp`, sub: 'u1', ...(colleague === undefined ? {} : { node_id: colleague }), scope: 'remember', jti: `FAKE${n}` }),
  'FAKEsig'.repeat(12),
].join('.');
const PLAIN = ['wat_', 'FAKEplainFAKEplainFAKE01'].join('');
const PLAIN2 = ['wat_', 'FAKEplainFAKEplainFAKE02'].join('');
const grant = (accessToken, over = {}) => ({
  nodeUrl: NODE, resource: `${NODE}/mcp`, mcpEndpoint: `${NODE}/mcp`, issuer: ISSUER, tokenEndpoint: `${ISSUER}/oauth/token`,
  clientId: STATIC_CLIENTS['claude-code'], connectedAt: '2026-01-01T00:00:00.000Z', accessToken, refreshToken: ['rtk_', 'FAKE'].join(''), expiresAt: null, scopes: ['remember'], ...over,
});
const sink = () => { const s = { text: '', write(t) { s.text += t; } }; return s; };
const noRenew = async (url) => { throw new Error(`no renewal expected (${url})`); };
const KEY_A = `${HOST}~col-a`;
const KEY_B = `${HOST}~col-b`;

function withHome(t) {
  const prev = process.env.WYBE_CONNECT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'wc-colleagues-'));
  process.env.WYBE_CONNECT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.WYBE_CONNECT_HOME; else process.env.WYBE_CONNECT_HOME = prev; rmSync(home, { recursive: true, force: true }); });
  return harnessHome('claude-code');
}

async function connectAs(accessToken, { fetchImpl = noRenew, argv = [NODE] } = {}) {
  const out = sink();
  const err = sink();
  let signIns = 0;
  const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv, out, err, nextSteps: () => '', fetchImpl, account: null, connectImpl: async (url, opts) => { signIns += 1; return grant(accessToken, { clientId: opts.clientId }); } });
  return { code, out: out.text, err: err.text, signIns };
}

test('colleagueOf reads the colleague a token names, without verifying it; anything else is null', () => {
  assert.equal(colleagueOf(token('col-a')), 'col-a');
  assert.equal(colleagueOf(PLAIN), null, 'an opaque token names no colleague');
  assert.equal(colleagueOf(token(undefined)), null, 'a JWT without the claim');
  assert.equal(colleagueOf(token('')), null);
  assert.equal(colleagueOf(token(42)), null);
  assert.equal(colleagueOf('a.b.c'), null);
  assert.equal(colleagueOf('only.two'), null);
  assert.equal(colleagueOf(null), null);
  assert.equal(colleagueOf(undefined), null);
});

test('colleagueName: the host and the colleague, a valid connection name; ids that look alike stay apart', () => {
  assert.equal(colleagueName(NODE, 'col-a'), KEY_A);
  assert.equal(colleagueName('https://colleagues.example.invalid:8443', 'col-a'), 'colleagues.example.invalid_8443~col-a');
  const odd = ['Col A', 'col a', 'col/a', 'ÆØÅ', 'x'.repeat(300), '-'];
  const names = odd.map((c) => colleagueName(NODE, c));
  for (const n of names) assert.equal(checkedName(n), n, `${n} is a valid name`);
  assert.equal(new Set([...names, KEY_A]).size, names.length + 1, 'distinct ids get distinct names');
});

test('saveConnection: two colleagues on one address are two connections; the same colleague again replaces its own', (t) => {
  const root = withHome(t);
  assert.equal(saveConnection(root, grant(token('col-a'))), KEY_A);
  assert.equal(saveConnection(root, grant(token('col-b'))), KEY_B);
  const before = loadCredentials(connectionPaths(root, KEY_A)).grantId;
  assert.equal(saveConnection(root, grant(token('col-a', 2))), KEY_A);
  const after = loadCredentials(connectionPaths(root, KEY_A));
  assert.equal(after.accessToken, token('col-a', 2));
  assert.notEqual(after.grantId, before, 'a new sign-in is a new grant');
  assert.deepEqual(connectionNames(root), [KEY_A, KEY_B]);
  assert.equal(loadCredentials(connectionPaths(root, KEY_B)).accessToken, token('col-b'), 'the other colleague is untouched');
});

test('saveConnection: a name that holds another colleague is refused, so one colleague\'s queue never passes to another', (t) => {
  const root = withHome(t);
  saveConnection(root, grant(token('col-a')));
  assert.throws(() => saveConnection(root, grant(token('col-b')), { name: KEY_A }), /another colleague/);
  assert.equal(loadCredentials(connectionPaths(root, KEY_A)).accessToken, token('col-a'));
});

test('connect.js to an address whose stored token names a colleague signs in again, never renews, and adds the new colleague', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(token('col-a')));
  const second = await connectAs(token('col-b'));
  assert.equal(second.code, 0, second.err);
  assert.equal(second.signIns, 1, 'a fresh sign-in');
  assert.doesNotMatch(second.out, /already connected/i);
  assert.match(second.out, new RegExp(`Also connected: ${KEY_A.replace(/\./g, '\\.')}`));
  assert.deepEqual(connectionNames(root), [KEY_A, KEY_B]);
  assert.equal(defaultConnection(root), KEY_B);
  assert.equal(loadCredentials(connectionPaths(root, KEY_A)).accessToken, token('col-a'), 'the first colleague is untouched');

  const again = await connectAs(token('col-a', 3));
  assert.equal(again.code, 0, again.err);
  assert.equal(again.signIns, 1);
  assert.deepEqual(connectionNames(root), [KEY_A, KEY_B], 'the same colleague replaces its own connection');
  assert.equal(loadCredentials(connectionPaths(root, KEY_A)).accessToken, token('col-a', 3));
  assert.ok(![second, again].some((r) => r.out.includes('eyJ') || r.err.includes('eyJ')), 'no token printed');
});

test('a connection made under the host\'s own name keeps working: its colleague again replaces it there, another colleague gets its own', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(token('col-a')), { name: HOST });
  const same = await connectAs(token('col-a', 2));
  assert.equal(same.code, 0, same.err);
  assert.deepEqual(connectionNames(root), [HOST]);
  assert.equal(loadCredentials(connectionPaths(root, HOST)).accessToken, token('col-a', 2));
  const other = await connectAs(token('col-b'));
  assert.equal(other.code, 0, other.err);
  assert.deepEqual(connectionNames(root), [HOST, KEY_B]);
  assert.equal(loadCredentials(connectionPaths(root, HOST)).accessToken, token('col-a', 2));
});

test('an address whose tokens name no colleague renews the stored grant as before: no sign-in', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(PLAIN));
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), `${ISSUER}/oauth/token`);
    assert.equal(new URLSearchParams(init.body).get('grant_type'), 'refresh_token');
    return new Response(JSON.stringify({ access_token: PLAIN2, refresh_token: ['rtk_', 'FAKE2'].join(''), expires_in: 3600, scope: 'remember' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const r = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out: sink(), err: sink(), nextSteps: () => '', fetchImpl, account: null, connectImpl: async () => { throw new Error('must not sign in'); } });
  assert.equal(r, 0);
  assert.deepEqual(connectionNames(root), [HOST]);
  assert.equal(loadCredentials(connectionPaths(root, HOST)).accessToken, PLAIN2);
});

test('the plugin MCP server\'s connect tool signs in again on such an address and stores the new colleague beside the first', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(token('col-a')));
  let signIns = 0;
  const proxy = createProxy({
    root, env: {}, clientId: STATIC_CLIENTS['claude-code'], harnessAccount: () => null, fetchImpl: noRenew,
    connectImpl: (_url, opts) => { signIns += 1; opts.onUrl(`${ISSUER}/oauth/authorize?x`); return Promise.resolve(grant(token('col-b'))); },
  });
  const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect', arguments: { node_url: NODE } } });
  assert.doesNotMatch(r.result.content[0].text, /renewed/);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(signIns, 1);
  assert.deepEqual(connectionNames(root), [KEY_A, KEY_B]);
});

test('two colleagues on one address: `use`, WYBE_CONNECT_NODE and session_id each reach the chosen colleague\'s token', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(token('col-a')));
  saveConnection(root, grant(token('col-b')));
  useConnection(root, KEY_A, { sessionId: 'sess-a' });
  useConnection(root, KEY_B, { sessionId: 'sess-b' });
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    const msg = JSON.parse(init.body);
    const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (msg.method === 'tools/call') seen.push([String(url), colleagueOf(init.headers.authorization.replace(/^Bearer /, ''))]);
    return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
  };
  const remember = (id, sessionId) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'remember', arguments: { items: [{ content: `fact ${id}` }], session_id: sessionId } } });
  const proxy = createProxy({ root, env: {}, fetchImpl });
  await proxy.handle(remember(1, 'sess-b'));
  await proxy.handle(remember(2, 'sess-a'));
  assert.deepEqual(seen, [[`${NODE}/mcp`, 'col-b'], [`${NODE}/mcp`, 'col-a']]);

  assert.equal(sessionConnection(root, { env: { WYBE_CONNECT_NODE: KEY_A } }), KEY_A);
  assert.equal(sessionConnection(root, { env: { WYBE_CONNECT_NODE: KEY_B } }), KEY_B);
  const out = sink();
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['use', KEY_A], out, err: sink(), nextSteps: () => '' }), 0);
  assert.equal(defaultConnection(root), KEY_A);
  const list = sink();
  await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['list'], out: list, err: sink(), nextSteps: () => '' });
  assert.match(list.text, new RegExp(`^\\* ${KEY_A.replace(/\./g, '\\.')} `, 'm'));
  assert.match(list.text, new RegExp(`^  ${KEY_B.replace(/\./g, '\\.')} `, 'm'));
  assert.equal(listConnections(root).length, 2);
});

test('a session on a colleague whose grant was refused never moves to another colleague on the same address', (t) => {
  const root = withHome(t);
  saveConnection(root, grant(token('col-a')));
  useConnection(root, KEY_A, { sessionId: 'sess-a' });
  const p = connectionPaths(root, KEY_A);
  saveCredentials({ ...loadCredentials(p), refusedAt: '2026-01-02T00:00:00.000Z' }, p);
  saveConnection(root, grant(token('col-b')));
  assert.equal(pinnedConnection(root, 'sess-a'), KEY_A, 'still on its own colleague');
  assert.equal(saveConnection(root, grant(token('col-a', 2))), KEY_A, 'the colleague\'s own sign-in brings it back');
  assert.equal(pinnedConnection(root, 'sess-a'), KEY_A);
});

test('a colleague-bearing access token is masked by redaction, bare or in a header', () => {
  const tok = token('col-a');
  for (const s of [`Authorization: Bearer ${tok}`, `the token is ${tok}.`, tok]) {
    const out = redact(s).text;
    assert.ok(!String(out).includes('eyJ'), String(out));
  }
});

test('the bare host names only the connection under the host\'s own name: with one colleague there, `use` and remove refuse and give its full name', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(PLAIN, { nodeUrl: 'https://other.example.invalid', resource: 'https://other.example.invalid/mcp', mcpEndpoint: 'https://other.example.invalid/mcp' }));
  saveConnection(root, grant(token('col-a')));
  for (const ref of [HOST, NODE, `${NODE}/`, HOST.toUpperCase()]) assert.equal(findConnection(root, ref), null, ref);
  assert.equal(sessionConnection(root, { env: { WYBE_CONNECT_NODE: HOST } }), null, 'a session takes a full name only');
  assert.equal(sessionConnection(root, { env: { WYBE_CONNECT_NODE: KEY_A } }), KEY_A);
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['use', 'other.example.invalid'], out: sink(), err: sink(), nextSteps: () => '' }), 0, 'a host-named connection is found by its host');
  for (const command of ['use', 'remove']) {
    const err = sink();
    assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: [command, HOST], out: sink(), err, nextSteps: () => '' }), 1, command);
    assert.ok(err.text.includes(KEY_A), err.text);
  }
  assert.deepEqual(connectionNames(root), [KEY_A, 'other.example.invalid'].sort());
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['use', KEY_A], out: sink(), err: sink(), nextSteps: () => '' }), 0);
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['remove', KEY_A], out: sink(), err: sink(), nextSteps: () => '' }), 0);
  assert.deepEqual(connectionNames(root), ['other.example.invalid']);
});

test('the bare host with several colleagues connected there is refused with their names, never a silent pick', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(token('col-a')));
  saveConnection(root, grant(token('col-b')));
  assert.equal(findConnection(root, HOST), null);
  assert.equal(findConnection(root, NODE), null);
  assert.equal(sessionConnection(root, { env: { WYBE_CONNECT_NODE: HOST } }), null, 'unknown means none, never one of them');
  for (const command of ['use', 'remove']) {
    const err = sink();
    assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: [command, HOST], out: sink(), err, nextSteps: () => '' }), 1, command);
    assert.ok(err.text.includes(KEY_A) && err.text.includes(KEY_B), err.text);
    assert.doesNotMatch(err.text, /no connection named/);
  }
  assert.deepEqual(connectionNames(root), [KEY_A, KEY_B], 'nothing removed');
  assert.equal(findConnection(root, KEY_B), KEY_B, 'a full name still finds its connection');
});
