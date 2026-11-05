// A grant the authorization server refuses for good (revoked in the portal, «Koble fra»): the first
// refresh that is answered invalid_grant marks the connection refused, once, and from then on no
// poller, node call, proxy call or flush presents the dead refresh token again. A transient failure
// (5xx, the network) never marks it. A new sign-in replaces the grant and clears the mark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectionPaths, saveConnection, sessionPaths, pinnedConnection, accountName, connectionKey } from '../lib/connections.js';
import { saveCredentials, loadCredentials, readJson, isRefused } from '../lib/home.js';
import { refreshTokens } from '../lib/oauth.js';
import { nodeCall, runPoller, touchSession, pausePoller } from '../lib/bridge.js';
import { createProxy } from '../lib/mcp-proxy.js';
import { createDelivery, newSummary } from '../lib/flush.js';
import { buildContext } from '../lib/session-context.js';
import { startFakeNode, grantFor, TOKEN, NEW_TOKEN } from './fixtures/fake-node.mjs';

const SID = 'sess-dead-0001';
const OTHER = 'sess-dead-0002';
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function setup(node, over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-revoked-'));
  const p = connectionPaths(root, 'node-a');
  saveCredentials(grantFor(node, over), p);
  const claude = mkdtempSync(join(tmpdir(), 'wybe-connect-claude-'));
  writeFileSync(join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'eier@example.invalid' } }));
  return { root, p, env: { CLAUDE_CONFIG_DIR: claude } };
}

/** The poller's answer, or 'still running' when it has not stopped within `ms` (then it is stopped). */
async function settle(p, sessionId, run, ms = 2000) {
  let timer;
  const late = new Promise((r) => { timer = setTimeout(() => r('still running'), ms); });
  const out = await Promise.race([run, late]);
  clearTimeout(timer);
  if (out === 'still running') {
    pausePoller(p, sessionId);
    await run;
  }
  return out;
}

const revokedNode = () => startFakeNode({ valid: 'wat_nobody-has-this' }).then((node) => Object.assign(node, { grant: 'revoked' }));

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refreshWith = (answer) => {
  let refused = 0;
  const run = refreshTokens({
    tokenEndpoint: 'https://auth.example.invalid/token', clientId: 'c1', refreshToken: 'wrt_x', resource: 'https://n.example.invalid/mcp', requestedScopes: [],
    fetchImpl: async () => answer(), timeoutMs: 200, onRefused: () => { refused += 1; },
  });
  return run.then((tokens) => ({ tokens, refused }));
};

test('refreshTokens: null on every failure, and onRefused only for an answer that says the grant is dead', async () => {
  for (const [label, answer, dead] of [
    ['400 invalid_grant', () => json({ error: 'invalid_grant' }, 400), 1],
    ['401 invalid_client', () => json({ error: 'invalid_client' }, 401), 1],
    ['400 unauthorized_client', () => json({ error: 'unauthorized_client' }, 400), 1],
    ['401 without a body', () => new Response('', { status: 401 }), 1],
    ['503', () => new Response('', { status: 503 }), 0],
    ['500 invalid_grant from a broken proxy', () => json({ error: 'invalid_grant' }, 500), 0],
    ['429', () => json({ error: 'slow_down' }, 429), 0],
    ['400 invalid_scope (nothing spent)', () => json({ error: 'invalid_scope' }, 400), 0],
    ['400 without a body', () => new Response('', { status: 400 }), 0],
    ['the network', () => { throw new TypeError('fetch failed'); }, 0],
    ['a timeout', () => { throw new DOMException('timed out', 'TimeoutError'); }, 0],
    ['200 without an access_token', () => json({ token_type: 'Bearer' }, 200), 0],
  ]) {
    const { tokens, refused } = await refreshWith(answer);
    assert.equal(tokens, null, label);
    assert.equal(refused, dead, label);
  }
});

test('a revoked grant: the poller exits gone after one refresh, the connection is marked once and keeps its grantId', async () => {
  const node = await revokedNode();
  try {
    const { p, env } = setup(node);
    touchSession(p, SID, { harness: 'claude-code', cwd: '/w/demo' });
    const out = await settle(p, SID, runPoller({ paths: p, sessionId: SID, env, intervalMs: 50, onTasks: async () => 'stop' }));
    assert.deepEqual(out, { exit: 'gone' });
    assert.equal(node.refreshes, 1, 'at most one refresh attempt');
    const onDisk = readJson(p.credentials);
    assert.match(onDisk.refusedAt, ISO);
    assert.equal(onDisk.grantId, 'g1');
    assert.equal(isRefused(onDisk), true);
  } finally {
    await node.close();
  }
});

test('a connection marked refused: a second poller and a node call make no node and no token call', async () => {
  const node = await revokedNode();
  try {
    const { p, env } = setup(node);
    touchSession(p, SID, { harness: 'claude-code' });
    await settle(p, SID, runPoller({ paths: p, sessionId: SID, env, intervalMs: 50, onTasks: async () => 'stop' }));
    const marked = readJson(p.credentials).refusedAt;
    const [refreshes, requests] = [node.refreshes, node.requests];
    touchSession(p, OTHER, { harness: 'claude-code' });
    const again = await settle(p, OTHER, runPoller({ paths: p, sessionId: OTHER, harness: 'claude-code', env, intervalMs: 50, onTasks: async () => 'stop' }));
    assert.deepEqual(again, { exit: 'gone' });
    assert.deepEqual(await nodeCall(p, 'inbox', { session_id: OTHER }), { ok: false, kind: 'not-connected' });
    assert.equal(node.refreshes, refreshes, 'no token call');
    assert.equal(node.requests, requests, 'no node call');
    assert.equal(readJson(p.credentials).refusedAt, marked, 'marked once');
  } finally {
    await node.close();
  }
});

test('a transient failure on refresh (503, the network) never marks the connection; the poller backs off and goes on', async () => {
  const node = await startFakeNode({ valid: 'wat_nobody-has-this' });
  try {
    node.grant = 'flaky';
    const { p, env } = setup(node);
    touchSession(p, SID, { harness: 'claude-code' });
    const out = await settle(p, SID, runPoller({ paths: p, sessionId: SID, env, intervalMs: 50, onTasks: async () => 'stop' }), 400);
    assert.equal(out, 'still running', 'a 503 is no reason to stop');
    assert.ok(node.refreshes >= 1);
    assert.equal(isRefused(readJson(p.credentials)), false);

    const down = async (url, init) => { if (String(url).endsWith('/oauth/token')) throw new TypeError('fetch failed'); return fetch(url, init); };
    assert.equal((await nodeCall(p, 'inbox', { session_id: SID }, { fetchImpl: down })).kind, 'auth');
    assert.equal(isRefused(readJson(p.credentials)), false);
  } finally {
    await node.close();
  }
});

test('a refusal of a refresh token another process has rotated meanwhile is a race, not a revocation: nothing is marked', async () => {
  const node = await revokedNode();
  try {
    const { p } = setup(node);
    const fetchImpl = async (url, init) => {
      // another poller of this connection refreshed first: same grant, the next refresh token
      if (String(url).endsWith('/oauth/token')) saveCredentials({ ...loadCredentials(p), accessToken: NEW_TOKEN, refreshToken: 'wrt_rotated' }, p);
      return fetch(url, init);
    };
    await nodeCall(p, 'inbox', { session_id: SID }, { fetchImpl });
    assert.equal(isRefused(readJson(p.credentials)), false);
    assert.equal(readJson(p.credentials).refreshToken, 'wrt_rotated');
  } finally {
    await node.close();
  }
});

test('a refused grant replaced meanwhile by a new sign-in (another grantId) is never marked', async () => {
  const node = await revokedNode();
  try {
    const { p } = setup(node);
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/oauth/token')) saveCredentials({ ...loadCredentials(p), grantId: 'g2', accessToken: NEW_TOKEN }, p);
      return fetch(url, init);
    };
    await nodeCall(p, 'inbox', { session_id: SID }, { fetchImpl });
    const onDisk = readJson(p.credentials);
    assert.equal(onDisk.grantId, 'g2');
    assert.equal(isRefused(onDisk), false);
  } finally {
    await node.close();
  }
});

test('connect after a refusal: a new grant replaces the marked one and everything works again', async () => {
  const node = await revokedNode();
  try {
    const { root, p, env } = setup(node);
    touchSession(p, SID, { harness: 'claude-code' });
    await settle(p, SID, runPoller({ paths: p, sessionId: SID, env, intervalMs: 50, onTasks: async () => 'stop' }));
    assert.equal(isRefused(readJson(p.credentials)), true);
    node.grant = 'live';
    node.valid = TOKEN;
    saveConnection(root, grantFor(node, { grantId: undefined }), { name: 'node-a' });
    assert.equal(isRefused(readJson(p.credentials)), false);
    assert.equal((await nodeCall(p, 'inbox', { session_id: SID })).ok, true);
  } finally {
    await node.close();
  }
});

test('the proxy: a revoked grant is refreshed once; then every call says to connect again with no node or token call', async () => {
  const node = await revokedNode();
  try {
    const root = mkdtempSync(join(tmpdir(), 'wybe-connect-revoked-proxy-'));
    const p = connectionPaths(root, saveConnection(root, grantFor(node)));
    const grantId = readJson(p.credentials).grantId;
    const proxy = createProxy({ root, env: {}, clientId: 'c-test', harnessAccount: () => null });
    const call = (id) => proxy.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'remember', arguments: { items: [{ content: 'x' }] } } });
    const first = await call(1);
    assert.match(first.result.content[0].text, /the connection was refused .*call `connect` again/);
    assert.equal(node.refreshes, 1);
    assert.equal(isRefused(readJson(p.credentials)), true);
    const [refreshes, requests] = [node.refreshes, node.requests];
    const second = await call(2);
    assert.match(second.result.content[0].text, /the connection was refused .*call `connect` again/);
    assert.equal(node.refreshes, refreshes, 'no token call');
    assert.equal(node.requests, requests, 'no node call');

    // connect: the refused grant is never renewed with its dead refresh token; a new sign-in replaces it
    let signIns = 0;
    const connectImpl = (_url, opts) => { signIns += 1; opts.onUrl('https://auth.example.invalid/authorize?x'); return Promise.resolve(grantFor(node, { grantId: undefined })); };
    const again = createProxy({ root, env: {}, clientId: 'c-test', harnessAccount: () => null, connectImpl });
    node.grant = 'live';
    node.valid = TOKEN;
    await again.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'connect', arguments: { node_url: node.base } } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(node.refreshes, refreshes, 'the dead refresh token is not presented to renew');
    assert.equal(signIns, 1);
    const onDisk = readJson(p.credentials);
    assert.equal(isRefused(onDisk), false);
    assert.notEqual(onDisk.grantId, grantId, 'a new grant');
    assert.equal((await again.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sessions_report', arguments: { sessions: [] } } })).result.isError, undefined, 'the new grant works');
  } finally {
    await node.close();
  }
});

test('a flush on a refused connection presents nothing, and one that meets the refusal marks it and stops its drain', async () => {
  const node = await revokedNode();
  try {
    const { p } = setup(node);
    const summary = newSummary('stop');
    const delivery = createDelivery({ credentials: loadCredentials(p), paths: p, summary });
    await delivery.deliver({ scope: 'sessions:light', turns: [] });
    await delivery.deliver({ scope: 'sessions:light', turns: [] });
    await delivery.drainQueue();
    assert.equal(node.refreshes, 1, 'one refresh, then none');
    assert.equal(isRefused(readJson(p.credentials)), true);
    assert.equal(summary.queued, 2, 'kept on this machine, not lost');
    assert.equal(summary.lastOutcome.kind, 'refused');
  } finally {
    await node.close();
  }
});

test('SessionStart on a refused connection says so and how to connect again, never that it is connected', () => {
  const ctx = buildContext({ credentials: { nodeUrl: 'https://demo.example.test', scopes: ['remember'], refusedAt: '2026-11-03T10:00:00.000Z' }, cached: null });
  assert.doesNotMatch(ctx, /You are connected/);
  assert.match(ctx, /refused/);
  assert.match(ctx, /`connect`/);
  assert.match(ctx, /https:\/\/demo\.example\.test/);
});

const markDead = (p) => saveCredentials({ ...readJson(p.credentials), refusedAt: '2026-11-03T10:00:00.000Z' }, p);
const ownGrant = (nodeUrl, account) => ({ nodeUrl, resource: `${nodeUrl}/mcp`, mcpEndpoint: `${nodeUrl}/mcp`, issuer: nodeUrl, tokenEndpoint: `${nodeUrl}/oauth/token`, clientId: 'c-test', accessToken: TOKEN, refreshToken: 'wrt_x', expiresAt: null, scopes: ['remember', 'sessions:light'], harnessAccount: account });
const NODE_A = 'https://node-a.example.invalid:8447';
const NODE_B = 'https://node-b.example.invalid';

test('connect after a refusal under another harness account takes over the refused connection, so the sessions on it work again', () => {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-revoked-reconnect-'));
  const dead = saveConnection(root, ownGrant(NODE_A, 'jobb@example.invalid'));
  assert.equal(sessionPaths(root, { sessionId: SID, env: {} }).connection, dead, 'the session is fixed to it');
  markDead(connectionPaths(root, dead));
  const key = saveConnection(root, ownGrant(NODE_A, 'privat@example.invalid'));
  assert.equal(key, dead, 'the name of the refused connection is reused, no second connection');
  assert.equal(key, connectionKey(NODE_A));
  assert.equal(isRefused(readJson(connectionPaths(root, key).credentials)), false);
  assert.equal(pinnedConnection(root, SID), key);
});

test('connect after a refusal that lands on another connection of the node moves every session fixed to the refused one there', () => {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-revoked-reconnect-'));
  const dead = saveConnection(root, ownGrant(NODE_A, 'jobb@example.invalid'));
  const own = saveConnection(root, ownGrant(NODE_A, 'privat@example.invalid'));
  assert.equal(own, accountName(NODE_A, 'privat@example.invalid'));
  const elsewhere = saveConnection(root, ownGrant(NODE_B, 'jobb@example.invalid'));
  for (const [sid, key] of [[SID, dead], [OTHER, elsewhere], ['sess-live-0003', own]]) {
    saveConnection(root, ownGrant(key === elsewhere ? NODE_B : NODE_A, key === own ? 'privat@example.invalid' : 'jobb@example.invalid'), { name: key });
    assert.equal(sessionPaths(root, { sessionId: sid, env: {} }).connection, key);
  }
  markDead(connectionPaths(root, dead));
  markDead(connectionPaths(root, elsewhere));
  const key = saveConnection(root, ownGrant(NODE_A, 'privat@example.invalid'));
  assert.equal(key, own, 'the own connection of this account on the node is signed in again');
  assert.equal(pinnedConnection(root, SID), own, 'moved off the refused connection of this node');
  assert.equal(pinnedConnection(root, 'sess-live-0003'), own);
  assert.equal(pinnedConnection(root, OTHER), elsewhere, 'a refused connection of another node keeps its sessions');
});
