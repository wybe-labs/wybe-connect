// Claude Code, Codex and Cursor sign in under fixed public clients (no dynamic registration), a re-run
// renews the stored grant instead of making a new one, and a token for another resource is never
// stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('every harness has a fixed client id', () => {
  assert.equal(STATIC_CLIENTS['claude-code'], 'wybe-connect-claude-code');
  assert.equal(STATIC_CLIENTS.codex, 'wybe-connect-codex');
  assert.equal(STATIC_CLIENTS.cursor, 'wybe-connect-cursor');
});

test('Cursor\'s connect.js signs in under wybe-connect-cursor and never calls registration', async (t) => {
  const prev = process.env.WYBE_CONNECT_HOME;
  const home = tempHome();
  process.env.WYBE_CONNECT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.WYBE_CONNECT_HOME; else process.env.WYBE_CONNECT_HOME = prev; rmSync(home, { recursive: true, force: true }); });
  const as = fakeAs();
  const browser = autoBrowser();
  const code = await runConnect({
    harness: 'cursor', clientName: 'wybe-connect (Cursor)', argv: [NODE], out: sink(), err: sink(), nextSteps: () => '', fetchImpl: as.fetchImpl,
    connectImpl: (url, opts) => connect(url, { ...opts, spawnImpl: browser.spawnImpl, platform: 'linux', timeoutMs: 5000 }),
  });
  assert.equal(code, 0);
  assert.equal(as.calls.filter((c) => c.url === METADATA.registration_endpoint).length, 0, 'no dynamic registration');
  assert.equal(browser.opened[0].searchParams.get('client_id'), 'wybe-connect-cursor');
  assert.equal(browser.opened[0].searchParams.get('account_hint'), null, 'Cursor has no account to name');
  assert.equal(as.tokenCalls()[0].client_id, 'wybe-connect-cursor');
  assert.equal(loadCredentials(connectionPaths(harnessHome('cursor'), 'node-a.example.invalid')).clientId, 'wybe-connect-cursor');
});

test('account_hint is sent on /authorize and never logged', async () => {
  const ACCOUNT = 'jobb.konto@example.invalid';
  const as = fakeAs();
  const browser = autoBrowser();
  const lines = [];
  const shown = [];
  const creds = await connect(NODE, {
    clientId: STATIC_CLIENTS['claude-code'], harnessAccount: ACCOUNT, fetchImpl: as.fetchImpl, spawnImpl: browser.spawnImpl, platform: 'linux', timeoutMs: 5000,
    log: (line) => lines.push(line), onUrl: (url) => shown.push(url),
  });
  assert.equal(browser.opened[0].searchParams.get('account_hint'), ACCOUNT, 'the browser gets the hint');
  assert.equal(creds.harnessAccount, ACCOUNT, 'the connection keeps the account it was made under');
  assert.ok(shown.length && lines.length);
  for (const text of [...lines, ...shown]) {
    assert.ok(!text.includes('account_hint') && !text.includes('jobb.konto') && !text.includes(encodeURIComponent(ACCOUNT)), text);
  }
  assert.equal(new URL(shown[0]).searchParams.get('client_id'), 'wybe-connect-claude-code', 'the URL shown still works without the hint');
  for (const c of as.calls) assert.ok(!String(c.body ?? '').includes('jobb.konto'), `never sent anywhere but /authorize: ${c.url}`);

  const none = autoBrowser();
  await connect(NODE, { clientId: STATIC_CLIENTS.codex, fetchImpl: fakeAs().fetchImpl, spawnImpl: none.spawnImpl, platform: 'linux', timeoutMs: 5000 });
  assert.equal(none.opened[0].searchParams.has('account_hint'), false, 'no account, no hint');
});

test('connect.js passes the harness account as the hint and prints it nowhere', async (t) => {
  const prev = process.env.WYBE_CONNECT_HOME;
  const home = tempHome();
  process.env.WYBE_CONNECT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.WYBE_CONNECT_HOME; else process.env.WYBE_CONNECT_HOME = prev; rmSync(home, { recursive: true, force: true }); });
  const claude = tempHome();
  writeFileSync(join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'jobb.konto@example.invalid' } }));
  const as = fakeAs();
  const browser = autoBrowser();
  const out = sink();
  const err = sink();
  const code = await runConnect({
    harness: 'claude-code', clientName: 'x', argv: [NODE], out, err, nextSteps: () => '', fetchImpl: as.fetchImpl, env: { CLAUDE_CONFIG_DIR: claude },
    connectImpl: (url, opts) => connect(url, { ...opts, spawnImpl: browser.spawnImpl, platform: 'linux', timeoutMs: 5000 }),
  });
  assert.equal(code, 0, err.text);
  assert.equal(browser.opened[0].searchParams.get('account_hint'), 'jobb.konto@example.invalid');
  assert.ok(!`${out.text}${err.text}`.includes('jobb.konto'), 'neither stdout nor stderr names the account');
});

test('the plugin MCP server connect tool sends the harness account as the hint, and its answer never names it', async () => {
  const home = tempHome();
  try {
    const root = harnessHome('claude-code', home);
    const as = fakeAs();
    const browser = autoBrowser();
    const proxy = createProxy({
      root, env: {}, clientId: STATIC_CLIENTS['claude-code'], fetchImpl: as.fetchImpl, harnessAccount: () => 'jobb.konto@example.invalid',
      connectImpl: (url, opts) => connect(url, { ...opts, spawnImpl: browser.spawnImpl, platform: 'linux', timeoutMs: 5000 }),
    });
    const call = (id) => proxy.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'connect', arguments: { node_url: NODE } } });
    const textOf = (r) => r.result.content.map((c) => c.text).join(' ');
    const answers = [textOf(await call(1))];
    for (let i = 2; i < 40 && !/Connected to/.test(answers.at(-1)); i++) {
      await new Promise((r) => setTimeout(r, 25));
      answers.push(textOf(await call(i)));
    }
    assert.match(answers.at(-1), /Connected to/);
    assert.equal(browser.opened[0].searchParams.get('account_hint'), 'jobb.konto@example.invalid');
    for (const a of answers) assert.ok(!a.includes('jobb.konto'), a);
    assert.equal(listConnections(root)[0].key, 'node-a.example.invalid');
    assert.equal(loadCredentials(connectionPaths(root, 'node-a.example.invalid')).harnessAccount, 'jobb.konto@example.invalid');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

test('connect without a fixed client id still registers', async () => {
  const as = fakeAs();
  const browser = autoBrowser();
  const creds = await connect(NODE, { clientName: 'wybe-connect (test)', fetchImpl: as.fetchImpl, spawnImpl: browser.spawnImpl, platform: 'linux', timeoutMs: 5000 });
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

test('connect.js run again renews the connection of the harness account it runs under, never the other account\'s', async (t) => {
  const prev = process.env.WYBE_CONNECT_HOME;
  const home = tempHome();
  process.env.WYBE_CONNECT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.WYBE_CONNECT_HOME; else process.env.WYBE_CONNECT_HOME = prev; rmSync(home, { recursive: true, force: true }); });
  const root = harnessHome('claude-code');
  const jobb = saveConnection(root, { ...stored(), harnessAccount: 'jobb@example.invalid' });
  const privat = saveConnection(root, { ...stored(), harnessAccount: 'privat@example.invalid' });
  assert.notEqual(jobb, privat);
  const as = fakeAs();
  const out = sink();
  const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out, err: sink(), nextSteps: () => '', fetchImpl: as.fetchImpl, account: 'privat@example.invalid', connectImpl: async () => { throw new Error('must not sign in'); } });
  assert.equal(code, 0);
  assert.match(out.text, /already connected/i);
  assert.equal(loadCredentials(connectionPaths(root, privat)).accessToken, ACCESS2, 'the second account\'s grant was renewed');
  assert.equal(loadCredentials(connectionPaths(root, jobb)).accessToken, ACCESS, 'the first account\'s grant was not touched');
});
