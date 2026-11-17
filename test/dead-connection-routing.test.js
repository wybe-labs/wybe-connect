// A connection whose grant was refused (revoked) is never chosen for a session while another one is live, so a session
// never sends nowhere by the routing rules alone. The case behind this test: the person's second Claude login had only
// one connection, revoked on a staging node; every new session under that login was fixed to it and reported nothing,
// while the live default sat unused. Every token here is fabricated and built at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATIC_CLIENTS } from '../lib/oauth.js';
import { connectionPaths, defaultConnection, pinnedConnection, resolveSession, saveConnection, sessionConnection, sessionLines, useConnection } from '../lib/connections.js';
import { harnessHome, loadCredentials, saveCredentials } from '../lib/home.js';

const STAGING = 'https://staging.example.invalid';
const PROD = 'https://prod.example.invalid';
const ISSUER = 'https://auth.example.invalid';
const SECOND = 'second-login@example.invalid';
const FIRST = 'first-login@example.invalid';
const plain = (n) => ['wat_', `FAKEplainFAKEplainFAKE0${n}`].join('');
const refresh = (n) => ['rtk_', `FAKErefreshFAKE0${n}`].join('');
const grant = (nodeUrl, n, harnessAccount) => ({
  nodeUrl, resource: `${nodeUrl}/mcp`, mcpEndpoint: `${nodeUrl}/mcp`, issuer: ISSUER, tokenEndpoint: `${ISSUER}/oauth/token`,
  clientId: STATIC_CLIENTS['claude-code'], accessToken: plain(n), refreshToken: refresh(n), expiresAt: null, scopes: ['remember'], harnessAccount,
});

function withHome(t) {
  const prev = process.env.WYBE_CONNECT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'wc-dead-'));
  process.env.WYBE_CONNECT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.WYBE_CONNECT_HOME; else process.env.WYBE_CONNECT_HOME = prev; rmSync(home, { recursive: true, force: true }); });
  return harnessHome('claude-code');
}

const refuse = (root, key) => {
  const p = connectionPaths(root, key);
  saveCredentials({ ...loadCredentials(p), refusedAt: '2026-01-02T00:00:00.000Z' }, p);
};

const transcript = (root, lines) => {
  const f = join(root, `t-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(f, 'l\n'.repeat(lines));
  return f;
};

/** The person's setup: staging made under the second login (now revoked), prod under the first login, prod the default. */
function setup(t) {
  const root = withHome(t);
  const staging = saveConnection(root, grant(STAGING, 1, SECOND));
  refuse(root, staging);
  const prod = saveConnection(root, grant(PROD, 2, FIRST));
  return { root, staging, prod };
}

test('a new session under the second login goes to the live default, not to its own login\'s revoked connection', (t) => {
  const { root, prod } = setup(t);
  assert.equal(sessionConnection(root, { sessionId: 's-new', env: {}, account: SECOND }), prod);
  assert.equal(resolveSession(root, { sessionId: 's-new', env: {}, account: SECOND, transcriptPath: transcript(root, 3) }), prod);
  assert.equal(pinnedConnection(root, 's-new'), prod);
});

test('a live connection of the session\'s own login is still chosen first', (t) => {
  const { root } = setup(t);
  const own = saveConnection(root, grant('https://other.example.invalid', 3, SECOND));
  useConnection(root, `prod.example.invalid`);
  assert.equal(sessionConnection(root, { sessionId: 's-own', env: {}, account: SECOND }), own);
});

test('the default is the most recent connection whose grant was not refused', (t) => {
  const { root, staging, prod } = setup(t);
  useConnection(root, 'staging.example.invalid');
  assert.equal(defaultConnection(root), prod);
  refuse(root, prod);
  // every one refused: the most recent, as before (a sign-in brings it back)
  assert.equal(defaultConnection(root), staging);
});

// ---- a session already fixed to a connection that is then refused (the rule the person chose: it follows) ----

function liveThenRefused(t) {
  const root = withHome(t);
  const staging = saveConnection(root, grant(STAGING, 1, SECOND));
  const file = transcript(root, 5);
  return { root, staging, file };
}

test('a session the plugin fixed follows to the live connection once its own is refused; its earlier lines stay', (t) => {
  const { root, staging, file } = liveThenRefused(t);
  assert.equal(resolveSession(root, { sessionId: 's-auto', env: {}, account: SECOND, transcriptPath: file }), staging);
  const prod = saveConnection(root, grant(PROD, 2, FIRST));
  refuse(root, staging);
  // the MCP server's read: where it sends now, without writing the pin
  assert.equal(sessionConnection(root, { sessionId: 's-auto', env: {}, account: SECOND }), prod);
  assert.equal(pinnedConnection(root, 's-auto'), staging);
  // the next hook moves the pin, so its later lines go to prod and the first five stay with staging
  writeFileSync(file, 'l\n'.repeat(8));
  assert.equal(resolveSession(root, { sessionId: 's-auto', env: {}, account: SECOND, transcriptPath: file }), prod);
  assert.equal(pinnedConnection(root, 's-auto'), prod);
  assert.deepEqual(sessionLines(root, 's-auto', prod), [[8, null]]);
});

test('a session the person fixed with use --session stays where they put it, refused or not', (t) => {
  const { root, staging, file } = liveThenRefused(t);
  resolveSession(root, { sessionId: 's-chosen', env: {}, account: SECOND, transcriptPath: file });
  useConnection(root, 'staging.example.invalid', { sessionId: 's-chosen' });
  saveConnection(root, grant(PROD, 2, FIRST));
  refuse(root, staging);
  assert.equal(sessionConnection(root, { sessionId: 's-chosen', env: {}, account: SECOND }), staging);
  assert.equal(resolveSession(root, { sessionId: 's-chosen', env: {}, account: SECOND, transcriptPath: file }), staging);
});

test('a session WYBE_CONNECT_NODE fixed stays too', (t) => {
  const { root, staging, file } = liveThenRefused(t);
  const env = { WYBE_CONNECT_NODE: 'staging.example.invalid' };
  assert.equal(resolveSession(root, { sessionId: 's-env', env, account: SECOND, transcriptPath: file }), staging);
  saveConnection(root, grant(PROD, 2, FIRST));
  refuse(root, staging);
  assert.equal(resolveSession(root, { sessionId: 's-env', env: {}, account: SECOND, transcriptPath: file }), staging);
});

test('with no live connection anywhere a session stays on its refused one', (t) => {
  const { root, staging, file } = liveThenRefused(t);
  resolveSession(root, { sessionId: 's-alone', env: {}, account: SECOND, transcriptPath: file });
  refuse(root, staging);
  assert.equal(resolveSession(root, { sessionId: 's-alone', env: {}, account: SECOND, transcriptPath: file }), staging);
});
