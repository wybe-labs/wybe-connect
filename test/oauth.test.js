import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { discover, pkcePair, register, authorizeUrl, exchangeCode, refreshTokens, startLoopback, openBrowser, connect, ALL_SCOPES, DEFAULT_ISSUER } from '../lib/oauth.js';

const NODE = 'https://demo.wybe.me';
const ISSUER = 'https://auth.wybe.me';
const ACCESS = ['wat_', 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');
const REFRESH = ['wrt_', 'Zx0Cv9Bn8Mm7Ll6Kk5Jj4Hh3Gg2Ff1Dd0Ss9Aa8Qq'].join('');
const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  code_challenge_methods_supported: ['S256'],
  scopes_supported: [...ALL_SCOPES],
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake authorization server + node discovery document. Records requests; token responses are configurable. */
function fakeAs({ metadata = METADATA, prm = { resource: NODE, authorization_servers: [ISSUER], scopes_supported: [...ALL_SCOPES] }, tokenAnswer, registerStatus = 201 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const rec = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null };
    calls.push(rec);
    if (rec.url === `${NODE}/.well-known/oauth-protected-resource`) return prm ? json(prm) : new Response('', { status: 404 });
    if (rec.url === `${ISSUER}/.well-known/oauth-authorization-server`) return json(metadata);
    if (rec.url === metadata.registration_endpoint) {
      if (registerStatus !== 201) return json({ error: 'invalid_client_metadata' }, registerStatus);
      return json({ client_id: 'dcr_client_1', redirect_uris: JSON.parse(rec.body).redirect_uris }, 201);
    }
    if (rec.url === metadata.token_endpoint) {
      const form = Object.fromEntries(new URLSearchParams(rec.body));
      return tokenAnswer ? tokenAnswer(form) : json({ access_token: ACCESS, token_type: 'bearer', expires_in: 3600, refresh_token: REFRESH, scope: 'remember sessions:light' });
    }
    return new Response('', { status: 404 });
  };
  return { calls, fetchImpl };
}

test('pkcePair: a 43-char base64url verifier and its S256 challenge', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(pkcePair().verifier, verifier);
});

test('discover: the node names its authorization server, whose metadata names the endpoints', async () => {
  const as = fakeAs();
  const d = await discover(`${NODE}/some/path`, { fetchImpl: as.fetchImpl });
  assert.equal(d.resource, NODE);
  assert.equal(d.mcpEndpoint, `${NODE}/mcp`);
  assert.equal(d.issuer, ISSUER);
  assert.deepEqual(d.metadata, METADATA);
  assert.deepEqual(d.resourceScopes, [...ALL_SCOPES]);
});

test('discover: without a protected-resource document the ruled issuer is used; without S256 it refuses; non-https refused', async () => {
  const as = fakeAs({ prm: null });
  const d = await discover(NODE, { fetchImpl: as.fetchImpl });
  assert.equal(d.issuer, DEFAULT_ISSUER);
  const weak = fakeAs({ metadata: { ...METADATA, code_challenge_methods_supported: ['plain'] } });
  await assert.rejects(discover(NODE, { fetchImpl: weak.fetchImpl }), /S256/);
  const missing = fakeAs({ metadata: { issuer: ISSUER } });
  await assert.rejects(discover(NODE, { fetchImpl: missing.fetchImpl }), /lacks authorization_endpoint/);
  await assert.rejects(discover('http://demo.wybe.me', { fetchImpl: as.fetchImpl }), /must be https/);
});

test('register: posts a public-client registration with exactly the loopback redirect_uri', async () => {
  const as = fakeAs();
  const r = await register({ metadata: METADATA, redirectUri: 'http://127.0.0.1:43123/callback', scopes: ['remember'], fetchImpl: as.fetchImpl });
  assert.equal(r.clientId, 'dcr_client_1');
  const body = JSON.parse(as.calls[0].body);
  assert.deepEqual(Object.keys(body).sort(), ['client_name', 'grant_types', 'redirect_uris', 'response_types', 'scope', 'software_id', 'token_endpoint_auth_method']);
  assert.deepEqual(body.redirect_uris, ['http://127.0.0.1:43123/callback']);
  assert.equal(body.token_endpoint_auth_method, 'none');
  assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
  await assert.rejects(register({ metadata: { ...METADATA, registration_endpoint: undefined }, redirectUri: 'x', scopes: [], fetchImpl: as.fetchImpl }), /no registration endpoint/);
});

test('authorizeUrl: the whole parameter set, S256, resource = the node', () => {
  const url = new URL(authorizeUrl({ metadata: METADATA, clientId: 'c1', redirectUri: 'http://127.0.0.1:1/callback', scopes: ['remember', 'sessions:light'], state: 'st', challenge: 'ch', resource: NODE }));
  assert.equal(url.origin + url.pathname, METADATA.authorization_endpoint);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'resource', 'response_type', 'scope', 'state']);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'remember sessions:light');
  assert.equal(url.searchParams.get('resource'), NODE);
});

test('exchangeCode: form-encoded, whole field set, verifier included, granted scope narrower than requested is honoured', async () => {
  const as = fakeAs();
  const now = Date.parse('2026-09-22T12:00:00Z');
  const t = await exchangeCode({ metadata: METADATA, clientId: 'c1', code: 'wac_code', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback', resource: NODE, requestedScopes: ALL_SCOPES, fetchImpl: as.fetchImpl, now });
  const form = Object.fromEntries(new URLSearchParams(as.calls[0].body));
  assert.equal(as.calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.keys(form).sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource']);
  assert.equal(form.code_verifier, 'v');
  assert.deepEqual(Object.keys(t).sort(), ['accessToken', 'expiresAt', 'refreshToken', 'scopes']);
  assert.equal(t.accessToken, ACCESS);
  assert.equal(t.refreshToken, REFRESH);
  assert.equal(t.expiresAt, '2026-09-22T13:00:00.000Z');
  assert.deepEqual(t.scopes, ['remember', 'sessions:light']);
});

test('exchangeCode: a refusal names the OAuth error without any token', async () => {
  const as = fakeAs({ tokenAnswer: () => json({ error: 'invalid_grant' }, 400) });
  await assert.rejects(exchangeCode({ metadata: METADATA, clientId: 'c1', code: 'x', verifier: 'v', redirectUri: 'r', resource: NODE, requestedScopes: [], fetchImpl: as.fetchImpl }), /HTTP 400 \(invalid_grant\)/);
});

test('refreshTokens: rotates, keeps the old refresh token when none is returned, null when the grant is gone', async () => {
  const rotated = fakeAs({ tokenAnswer: (form) => (form.grant_type === 'refresh_token' && form.refresh_token === REFRESH ? json({ access_token: ACCESS, expires_in: 60, refresh_token: 'wrt_next' }) : json({ error: 'invalid_grant' }, 400)) });
  const a = await refreshTokens({ tokenEndpoint: METADATA.token_endpoint, clientId: 'c1', refreshToken: REFRESH, resource: NODE, requestedScopes: ['remember'], fetchImpl: rotated.fetchImpl });
  assert.equal(a.refreshToken, 'wrt_next');
  assert.deepEqual(a.scopes, ['remember']);
  const form = Object.fromEntries(new URLSearchParams(rotated.calls[0].body));
  assert.deepEqual(Object.keys(form).sort(), ['client_id', 'grant_type', 'refresh_token', 'resource']);

  const keep = fakeAs({ tokenAnswer: () => json({ access_token: ACCESS }) });
  const b = await refreshTokens({ tokenEndpoint: METADATA.token_endpoint, clientId: 'c1', refreshToken: REFRESH, resource: NODE, requestedScopes: [], fetchImpl: keep.fetchImpl });
  assert.equal(b.refreshToken, REFRESH);

  const gone = fakeAs({ tokenAnswer: () => json({ error: 'invalid_grant' }, 400) });
  assert.equal(await refreshTokens({ tokenEndpoint: METADATA.token_endpoint, clientId: 'c1', refreshToken: REFRESH, resource: NODE, requestedScopes: [], fetchImpl: gone.fetchImpl }), null);
  assert.equal(await refreshTokens({ tokenEndpoint: METADATA.token_endpoint, clientId: 'c1', refreshToken: null, resource: NODE, requestedScopes: [], fetchImpl: gone.fetchImpl }), null);
});

function getStatus(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
}

test('startLoopback: receives the code once the state matches; wrong state and error answers reject', async () => {
  const ok = startLoopback({ expectedState: 'st-1', timeoutMs: 5000 });
  const uri = await ok.redirectUri;
  assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(await getStatus(`${uri}?code=wac_abc&state=st-1`), 200);
  assert.deepEqual(await ok.result, { code: 'wac_abc' });

  const bad = startLoopback({ expectedState: 'st-2', timeoutMs: 5000 });
  const badUri = await bad.redirectUri;
  assert.equal(await getStatus(`${badUri}?code=wac_abc&state=other`), 400);
  await assert.rejects(bad.result, /state mismatch/);

  const err = startLoopback({ expectedState: 'st-3', timeoutMs: 5000 });
  const errUri = await err.redirectUri;
  assert.equal(await getStatus(`${errUri}?error=access_denied&state=st-3`), 400);
  await assert.rejects(err.result, /authorization refused: access_denied/);

  const slow = startLoopback({ expectedState: 'st-4', timeoutMs: 30 });
  await slow.redirectUri;
  await assert.rejects(slow.result, /no callback within/);
});

test('openBrowser: spawns the platform opener with the URL as one argument, never through a shell', () => {
  const url = 'https://auth.wybe.me/oauth/authorize?a=1&b=2&state=x';
  const seen = [];
  const spawnImpl = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return { unref() {}, on() {} }; };
  assert.equal(openBrowser(url, { platform: 'win32', spawnImpl }), true);
  assert.equal(openBrowser(url, { platform: 'darwin', spawnImpl }), true);
  assert.equal(openBrowser(url, { platform: 'linux', spawnImpl }), true);
  assert.deepEqual(seen.map((s) => s.cmd), ['rundll32', 'open', 'xdg-open']);
  assert.deepEqual(seen[0].args, ['url.dll,FileProtocolHandler', url]);
  assert.deepEqual(seen[1].args, [url]);
  assert.deepEqual(seen[2].args, [url]);
  for (const s of seen) assert.equal(s.opts.shell, undefined);
  assert.equal(openBrowser(url, { platform: 'linux', spawnImpl: () => { throw new Error('ENOENT'); } }), false);
});

test('connect: the whole flow end to end against a fake AS and a real loopback; the log never carries a token', async () => {
  const as = fakeAs();
  const log = [];
  const spawnImpl = (cmd, args) => {
    const authorize = new URL(args.at(-1));
    const redirect = new URL(authorize.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', 'wac_e2e');
    redirect.searchParams.set('state', authorize.searchParams.get('state'));
    setTimeout(() => getStatus(redirect.toString()).catch(() => {}), 10);
    return { unref() {}, on() {} };
  };
  const now = () => Date.parse('2026-09-22T12:00:00Z');
  const creds = await connect(NODE, { fetchImpl: as.fetchImpl, spawnImpl, platform: 'linux', log: (l) => log.push(l), now, timeoutMs: 5000 });
  assert.deepEqual(Object.keys(creds).sort(), ['accessToken', 'clientId', 'connectedAt', 'expiresAt', 'issuer', 'mcpEndpoint', 'nodeUrl', 'refreshToken', 'scopes', 'tokenEndpoint']);
  assert.equal(creds.accessToken, ACCESS);
  assert.equal(creds.refreshToken, REFRESH);
  assert.equal(creds.mcpEndpoint, `${NODE}/mcp`);
  assert.equal(creds.clientId, 'dcr_client_1');
  assert.equal(creds.connectedAt, '2026-09-22T12:00:00.000Z');
  const tokenForm = Object.fromEntries(new URLSearchParams(as.calls.find((c) => c.url === METADATA.token_endpoint).body));
  assert.equal(tokenForm.code, 'wac_e2e');
  assert.equal(tokenForm.resource, NODE);
  assert.equal(createHash('sha256').update(tokenForm.code_verifier).digest('base64url'), new URL(log.find((l) => l.includes('/oauth/authorize')).split('\n')[1]).searchParams.get('code_challenge'));
  const joined = log.join('\n');
  assert.ok(joined.length > 0, 'the log captured lines');
  assert.ok(!joined.includes(ACCESS) && !joined.includes(REFRESH), 'a token reached the log');
});

test('connect: a registration refusal closes the loopback and surfaces the refusal', async () => {
  const as = fakeAs({ registerStatus: 429 });
  let opened = 0;
  await assert.rejects(connect(NODE, { fetchImpl: as.fetchImpl, spawnImpl: () => { opened += 1; return { unref() {}, on() {} }; }, timeoutMs: 5000 }), /registration refused: HTTP 429/);
  assert.equal(opened, 0, 'no browser may open when there is no client');
});
