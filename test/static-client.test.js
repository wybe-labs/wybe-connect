// Claude Code and Codex sign in under fixed public clients (no dynamic registration), a re-run
// renews the stored grant instead of making a new one, and a token for another resource is never
// stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { connect, discover, exchangeCode, refreshTokens, renewGrant, STATIC_CLIENTS, ALL_SCOPES } from '../lib/oauth.js';
import { runConnect } from '../lib/connect-cli.js';
import { connectionPaths, saveConnection, listConnections } from '../lib/connections.js';
import { loadCredentials, harnessHome } from '../lib/home.js';
import { createProxy } from '../lib/mcp-proxy.js';

const NODE = 'https://node-a.example.invalid';
const ISSUER = 'https://auth.example.invalid';
const ACCESS = ['wat_', 'FAKEaccessFAKEaccessFAKE01'].join('');
const ACCESS2 = ['wat_', 'FAKEaccessFAKEaccessFAKE02'].join('');
const REFRESH = ['wrt_', 'FAKErefreshFAKErefresh01'].join('');
const REFRESH2 = ['wrt_', 'FAKErefreshFAKErefresh02'].join('');
const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  code_challenge_methods_supported: ['S256'],
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jwt = (payload) => ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'FAKEsig'].join('.');

function fakeAs({ prm = { resource: `${NODE}/mcp`, authorization_servers: [ISSUER] }, tokenAnswer = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const rec = { url: String(url), body: init.body ?? null };
    calls.push(rec);
    if (rec.url === `${NODE}/.well-known/oauth-protected-resource`) return json(prm);
    if (rec.url === `${ISSUER}/.well-known/oauth-authorization-server`) return json(METADATA);
    if (rec.url === METADATA.registration_endpoint) return json({ client_id: 'dcr_client_1' }, 201);
    if (rec.url === METADATA.token_endpoint) {
      const form = Object.fromEntries(new URLSearchParams(rec.body));
      if (tokenAnswer) return tokenAnswer(form);
      return form.grant_type === 'refresh_token'
        ? json({ access_token: ACCESS2, refresh_token: REFRESH2, expires_in: 3600, scope: ALL_SCOPES.join(' ') })
        : json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: ALL_SCOPES.join(' ') });
    }
    return new Response('', { status: 404 });
  };
  return { calls, fetchImpl, tokenCalls: () => calls.filter((c) => c.url === METADATA.token_endpoint).map((c) => Object.fromEntries(new URLSearchParams(c.body))) };
}

/** A browser that follows the authorization URL straight to the loopback callback with a code. */
function autoBrowser() {
  const opened = [];
  const spawnImpl = (_cmd, args) => {
    const u = new URL(args[args.length - 1]);
    opened.push(u);
    const cb = new URL(u.searchParams.get('redirect_uri'));
    cb.searchParams.set('code', 'FAKEcode');
    cb.searchParams.set('state', u.searchParams.get('state'));
    setTimeout(() => httpGet(cb, (res) => res.resume()).on('error', () => {}), 5);
    return { unref() {}, on() {} };
  };
  return { opened, spawnImpl };
}

const tempHome = () => mkdtempSync(join(tmpdir(), 'wc-static-'));
const sink = () => { const s = { text: '', write(t) { s.text += t; } }; return s; };

test('the two coding harnesses have fixed client ids; others have none', () => {
  assert.equal(STATIC_CLIENTS['claude-code'], 'wybe-connect-claude-code');
  assert.equal(STATIC_CLIENTS.codex, 'wybe-connect-codex');
  assert.equal(STATIC_CLIENTS.cursor, undefined);
});

test('connect with a fixed client id never registers a client and asks for the node /mcp resource', async () => {
  const as = fakeAs();
  const browser = autoBrowser();
  const creds = await connect(NODE, { clientId: STATIC_CLIENTS['claude-code'], fetchImpl: as.fetchImpl, spawnImpl: browser.spawnImpl, platform: 'linux', timeoutMs: 5000 });
  assert.equal(as.calls.filter((c) => c.url === METADATA.registration_endpoint).length, 0, 'no dynamic registration');
  const auth = browser.opened[0];
  assert.equal(auth.searchParams.get('client_id'), 'wybe-connect-claude-code');
  assert.match(auth.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(auth.searchParams.get('resource'), `${NODE}/mcp`);
  assert.equal(as.tokenCalls()[0].client_id, 'wybe-connect-claude-code');
  assert.equal(as.tokenCalls()[0].resource, `${NODE}/mcp`);
  assert.equal(creds.clientId, 'wybe-connect-claude-code');
  assert.equal(creds.resource, `${NODE}/mcp`);
});

test('without a fixed client id the harness still registers (cursor)', async () => {
  const as = fakeAs();
  const browser = autoBrowser();
  const creds = await connect(NODE, { clientName: 'wybe-connect (Cursor)', fetchImpl: as.fetchImpl, spawnImpl: browser.spawnImpl, platform: 'linux', timeoutMs: 5000 });
  assert.equal(creds.clientId, 'dcr_client_1');
});

test('discover refuses a node whose metadata names a resource other than its /mcp endpoint', async () => {
  for (const resource of [NODE, `${NODE}/`, `${NODE}/api`, `${NODE}/mcp/other`]) {
    const as = fakeAs({ prm: { resource, authorization_servers: [ISSUER] } });
    await assert.rejects(discover(NODE, { fetchImpl: as.fetchImpl }), /\/mcp/, resource);
  }
  const ok = fakeAs({ prm: { resource: `${NODE}/mcp/`, authorization_servers: [ISSUER] } });
  assert.equal((await discover(NODE, { fetchImpl: ok.fetchImpl })).resource, `${NODE}/mcp`, 'a trailing slash is the same endpoint');
});

test('a token issued for another resource is refused at the exchange, so nothing can be stored', async () => {
  const cases = [
    { access_token: ACCESS, resource: 'https://other.example.invalid/mcp' },
    { access_token: ACCESS, aud: 'https://other.example.invalid/mcp' },
    { access_token: jwt({ aud: ['https://other.example.invalid/mcp'] }) },
  ];
  for (const answer of cases) {
    const as = fakeAs({ tokenAnswer: () => json(answer) });
    await assert.rejects(
      exchangeCode({ metadata: METADATA, clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback', resource: `${NODE}/mcp`, requestedScopes: ['remember'], fetchImpl: as.fetchImpl }),
      /another resource/,
    );
  }
  const good = fakeAs({ tokenAnswer: () => json({ access_token: jwt({ aud: [`${NODE}/mcp`] }), resource: `${NODE}/mcp` }) });
  const c = await exchangeCode({ metadata: METADATA, clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback', resource: `${NODE}/mcp`, requestedScopes: ['remember'], fetchImpl: good.fetchImpl });
  assert.equal(typeof c.accessToken, 'string');
});

test('a refresh answered with a token for another resource counts as no refresh', async () => {
  const as = fakeAs({ tokenAnswer: () => json({ access_token: jwt({ aud: 'https://other.example.invalid/mcp' }), refresh_token: REFRESH2 }) });
  assert.equal(await refreshTokens({ tokenEndpoint: METADATA.token_endpoint, clientId: 'c', refreshToken: REFRESH, resource: `${NODE}/mcp`, requestedScopes: ['remember'], fetchImpl: as.fetchImpl }), null);
});

const stored = (clientId = STATIC_CLIENTS['claude-code'], scopes = [...ALL_SCOPES]) => ({
  nodeUrl: NODE, resource: `${NODE}/mcp`, mcpEndpoint: `${NODE}/mcp`, issuer: ISSUER, tokenEndpoint: METADATA.token_endpoint,
  clientId, connectedAt: '2026-01-01T00:00:00.000Z', accessToken: ACCESS, refreshToken: REFRESH, expiresAt: null, scopes,
});

test('renewGrant refreshes a stored grant of the same fixed client and node, else gives null', async () => {
  const as = fakeAs();
  const next = await renewGrant(stored(), { clientId: STATIC_CLIENTS['claude-code'], nodeUrl: NODE, fetchImpl: as.fetchImpl });
  assert.equal(next.accessToken, ACCESS2);
  assert.equal(next.refreshToken, REFRESH2);
  assert.equal(next.clientId, 'wybe-connect-claude-code');
  assert.equal(await renewGrant(stored('dcr_client_1'), { clientId: STATIC_CLIENTS['claude-code'], nodeUrl: NODE, fetchImpl: as.fetchImpl }), null, 'an old registered client is replaced by a sign-in');
  assert.equal(await renewGrant(stored(), { clientId: STATIC_CLIENTS['claude-code'], nodeUrl: 'https://node-b.example.invalid', fetchImpl: as.fetchImpl }), null, 'another node');
  assert.equal(await renewGrant({ ...stored(), refreshToken: null }, { clientId: STATIC_CLIENTS['claude-code'], nodeUrl: NODE, fetchImpl: as.fetchImpl }), null, 'no refresh token');
  assert.equal(await renewGrant(stored(), { clientId: STATIC_CLIENTS['claude-code'], nodeUrl: NODE, scopes: ['remember', 'extra:scope'], fetchImpl: as.fetchImpl }), null, 'wider scopes need a sign-in');
  const gone = fakeAs({ tokenAnswer: () => json({ error: 'invalid_grant' }, 400) });
  assert.equal(await renewGrant(stored(), { clientId: STATIC_CLIENTS['claude-code'], nodeUrl: NODE, fetchImpl: gone.fetchImpl }), null, 'a revoked grant');
});

test('connect.js run again on a connected node renews the grant: no browser, no new grant, same grantId', async (t) => {
  const prev = process.env.WYBE_CONNECT_HOME;
  const home = tempHome();
  process.env.WYBE_CONNECT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.WYBE_CONNECT_HOME; else process.env.WYBE_CONNECT_HOME = prev; rmSync(home, { recursive: true, force: true }); });
  const root = harnessHome('claude-code');
  const key = saveConnection(root, stored());
  const grantId = loadCredentials(connectionPaths(root, key)).grantId;
  const as = fakeAs();
  let signIns = 0;
  const out = sink();
  const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out, err: sink(), nextSteps: () => '', fetchImpl: as.fetchImpl, connectImpl: async () => { signIns += 1; throw new Error('must not sign in'); } });
  assert.equal(code, 0);
  assert.equal(signIns, 0);
  const after = loadCredentials(connectionPaths(root, key));
  assert.equal(after.accessToken, ACCESS2);
  assert.equal(after.grantId, grantId, 'a renewal keeps the grant identity');
  assert.match(out.text, /already connected/i);
  assert.equal(listConnections(root).length, 1);
});

test('connect.js signs in under the fixed client when the stored grant cannot be renewed', async (t) => {
  const prev = process.env.WYBE_CONNECT_HOME;
  const home = tempHome();
  process.env.WYBE_CONNECT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.WYBE_CONNECT_HOME; else process.env.WYBE_CONNECT_HOME = prev; rmSync(home, { recursive: true, force: true }); });
  const root = harnessHome('codex');
  saveConnection(root, stored('dcr_client_1'));
  const as = fakeAs();
  const seen = [];
  const code = await runConnect({ harness: 'codex', clientName: 'wybe-connect (Codex)', argv: [NODE], out: sink(), err: sink(), nextSteps: () => '', fetchImpl: as.fetchImpl, connectImpl: async (url, opts) => { seen.push(opts.clientId); return { ...stored(opts.clientId), accessToken: ACCESS2 }; } });
  assert.equal(code, 0);
  assert.deepEqual(seen, ['wybe-connect-codex']);
});

test('the plugin MCP server connect tool renews a stored grant without a browser', async () => {
  const home = tempHome();
  try {
    const root = harnessHome('claude-code', home);
    saveConnection(root, stored());
    const as = fakeAs();
    let signIns = 0;
    const proxy = createProxy({ root, env: {}, clientId: STATIC_CLIENTS['claude-code'], fetchImpl: as.fetchImpl, connectImpl: async () => { signIns += 1; throw new Error('must not sign in'); } });
    const call = (id) => proxy.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'connect', arguments: { node_url: NODE } } });
    const first = await call(1);
    const textOf = (r) => r.result.content.map((c) => c.text).join(' ');
    let msg = textOf(first);
    if (!/connected/i.test(msg) || /browser/i.test(msg)) msg = textOf(await call(2));
    assert.match(msg, /connected/i);
    assert.doesNotMatch(msg, /browser/i);
    assert.equal(signIns, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
