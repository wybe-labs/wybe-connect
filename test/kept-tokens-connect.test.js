// Tokens a refresh kept because its save did not hold (lib/refresh.js «keep») outside refreshStored:
// `connect` renewing a stored grant presents the kept refresh token, never the spent one on disk, and
// a new sign-in or a renewal leaves no kept file behind. Every token here is fabricated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { STATIC_CLIENTS } from '../lib/oauth.js';
import { runConnect } from '../lib/connect-cli.js';
import { connectionPaths, saveConnection } from '../lib/connections.js';
import { harnessHome, loadCredentials } from '../lib/home.js';
import { rotatedPath } from '../lib/refresh.js';

const NODE = 'https://kept.example.invalid';
const HOST = 'kept.example.invalid';
const ISSUER = 'https://auth.example.invalid';
const SPENT = ['rtk_', 'FAKEspent'].join('');
const KEPT = ['rtk_', 'FAKEkept'].join('');
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const grant = (over = {}) => ({
  nodeUrl: NODE, resource: `${NODE}/mcp`, mcpEndpoint: `${NODE}/mcp`, issuer: ISSUER, tokenEndpoint: `${ISSUER}/oauth/token`,
  clientId: STATIC_CLIENTS['claude-code'], connectedAt: '2026-01-01T00:00:00.000Z', accessToken: ['wat_', 'FAKEold'].join(''),
  refreshToken: SPENT, expiresAt: null, scopes: ['remember'], ...over,
});
const sink = () => ({ write() {} });

function withHome(t) {
  const prev = process.env.WYBE_CONNECT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'wc-kept-'));
  process.env.WYBE_CONNECT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.WYBE_CONNECT_HOME; else process.env.WYBE_CONNECT_HOME = prev; rmSync(home, { recursive: true, force: true }); });
  return harnessHome('claude-code');
}

function keep(p, grantId) {
  writeFileSync(rotatedPath(p), JSON.stringify({ grantId, from: sha256(SPENT), tokens: { accessToken: ['wat_', 'FAKEkept'].join(''), refreshToken: KEPT, expiresAt: '2026-01-01T01:00:00.000Z' } }));
}

test('connect renews a stored grant with the kept refresh token, never the spent one on disk, and removes the kept file', async (t) => {
  const root = withHome(t);
  const key = saveConnection(root, grant());
  const p = connectionPaths(root, key);
  keep(p, loadCredentials(p).grantId);
  const presented = [];
  const fetchImpl = async (_url, init) => {
    presented.push(new URLSearchParams(init.body).get('refresh_token'));
    return new Response(JSON.stringify({ access_token: ['wat_', 'FAKEnew'].join(''), refresh_token: ['rtk_', 'FAKEnew'].join(''), expires_in: 3600, scope: 'remember' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out: sink(), err: sink(), nextSteps: () => '', fetchImpl, account: null, connectImpl: async () => { throw new Error('must not sign in'); } });
  assert.equal(code, 0);
  assert.deepEqual(presented, [KEPT]);
  assert.equal(loadCredentials(connectionPaths(root, HOST)).refreshToken, ['rtk_', 'FAKEnew'].join(''));
  assert.equal(existsSync(rotatedPath(p)), false);
});

test('a new sign-in over a connection leaves no kept file of the grant it replaced', (t) => {
  const root = withHome(t);
  const key = saveConnection(root, grant());
  const p = connectionPaths(root, key);
  keep(p, loadCredentials(p).grantId);
  assert.equal(saveConnection(root, grant({ accessToken: ['wat_', 'FAKEsignin'].join('') })), key);
  assert.equal(existsSync(rotatedPath(p)), false);
});
