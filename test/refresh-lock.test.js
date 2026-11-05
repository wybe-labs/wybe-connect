// Every process of one connection (each session's poller, the MCP proxy, flushes, distil) refreshes
// the same grant. The authorization server rotates the refresh token on every refresh and revokes the
// whole grant when a rotated one is presented again, so two processes refreshing at once kill the
// grant. One refresh at a time per connection, across processes (lib/refresh.js): the first takes
// the lock and refreshes; everyone after it finds the new tokens on disk and makes no token call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { connectionPaths } from '../lib/connections.js';
import { saveCredentials, loadCredentials, readJson, isRefused } from '../lib/home.js';
import { nodeCall } from '../lib/bridge.js';
import { createProxy } from '../lib/mcp-proxy.js';
import { createDelivery, newSummary } from '../lib/flush.js';
import { acquireAsync } from '../lib/lock.js';
import { refreshStored, refreshLockPath, REFRESH_LOCK_MAX_HOLD_MS } from '../lib/refresh.js';
import { startFakeNode, grantFor, TOKEN, REFRESH } from './fixtures/fake-node.mjs';

const SID = 'sess-lock-0001';
const LIB = (f) => pathToFileURL(join(import.meta.dirname, '..', 'lib', f)).href;

/** A node whose token endpoint rotates and detects reuse, that no longer takes the stored access token. */
async function rotatingNode({ tokenDelayMs = 150 } = {}) {
  const node = await startFakeNode({ valid: 'wat_expired-elsewhere' });
  node.grant = 'rotating';
  node.tokenDelayMs = tokenDelayMs;
  return node;
}

function setup(node, over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-refresh-lock-'));
  const p = connectionPaths(root, 'node-a');
  saveCredentials(grantFor(node, over), p);
  return { root, p };
}

/** A real process that makes one node call on connection `node-a` of `root` when it reads a line on stdin. */
function caller(root) {
  const src = `import { nodeCall } from ${JSON.stringify(LIB('bridge.js'))};
import { connectionPaths } from ${JSON.stringify(LIB('connections.js'))};
const p = connectionPaths(${JSON.stringify(root)}, 'node-a');
process.stdout.write('READY\\n');
process.stdin.once('data', async () => {
  const out = await nodeCall(p, 'inbox', { session_id: ${JSON.stringify(SID)} });
  process.stdout.write('RESULT ' + JSON.stringify({ ok: out.ok, kind: out.kind ?? null }) + '\\n');
  process.exit(0);
});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  let out = '';
  const ready = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('READY')) resolve(); }));
  const result = new Promise((resolve) => child.on('exit', () => {
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    resolve(line ? JSON.parse(line.slice(7)) : { ok: false, kind: 'no answer' });
  }));
  return { child, ready, result };
}

test('ten processes meet an expired token at once: one token call, every one ends on the new token, nothing marked', async () => {
  const node = await rotatingNode();
  try {
    const { root, p } = setup(node);
    const callers = Array.from({ length: 10 }, () => caller(root));
    await Promise.all(callers.map((c) => c.ready));
    for (const c of callers) c.child.stdin.end('go\n'); // all at once, as ten sessions' hooks do
    const results = await Promise.all(callers.map((c) => c.result));
    assert.equal(node.reused, 0, 'no rotated refresh token was presented again');
    assert.equal(node.refreshes, 1, 'exactly one token call');
    assert.deepEqual(results, Array.from({ length: 10 }, () => ({ ok: true, kind: null })));
    const inbox = node.tool('inbox');
    assert.equal(inbox.length, 10);
    for (const call of inbox) assert.equal(call.auth, 'Bearer wat_rotated-1');
    const onDisk = readJson(p.credentials);
    assert.equal(isRefused(onDisk), false, 'no refusedAt');
    assert.equal(onDisk.accessToken, 'wat_rotated-1');
    assert.equal(onDisk.refreshToken, 'wrt_rotated-1');
    assert.equal(onDisk.grantId, 'g1');
    assert.equal(existsSync(refreshLockPath(p)), false, 'the lock is released');
  } finally {
    await node.close();
  }
});

test('every refresh call site of one process (node calls, the MCP proxy, a flush) goes through the one locked refresh', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const proxy = createProxy({ paths: p, env: {}, clientId: 'c-test', harnessAccount: () => null });
    const proxied = (id) => proxy.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'sessions_report', arguments: { sessions: [] } } });
    const flush = () => createDelivery({ credentials: loadCredentials(p), paths: p, summary: newSummary('Stop') }).deliver({ scope: 'sessions:light', turns: [] });
    const out = await Promise.all([
      nodeCall(p, 'inbox', { session_id: SID }), nodeCall(p, 'inbox', { session_id: SID }), nodeCall(p, 'inbox', { session_id: SID }),
      proxied(1), proxied(2), proxied(3),
      flush(), flush(),
    ]);
    assert.equal(node.reused, 0);
    assert.equal(node.refreshes, 1, 'exactly one token call');
    for (const r of out.slice(0, 3)) assert.equal(r.ok, true);
    for (const r of out.slice(3, 6)) assert.equal(r.result.isError, undefined);
    assert.equal(isRefused(readJson(p.credentials)), false);
    assert.equal(readJson(p.credentials).refreshToken, 'wrt_rotated-1');
  } finally {
    await node.close();
  }
});

test('a process still holding tokens another process rotated uses the stored ones and presents no spent refresh token', async () => {
  const node = await rotatingNode({ tokenDelayMs: 0 });
  try {
    const { p } = setup(node);
    const stale = loadCredentials(p); // this flush loaded the grant before another process refreshed it
    assert.equal((await nodeCall(p, 'inbox', { session_id: SID })).ok, true); // that other process
    assert.equal(node.refreshes, 1);
    const summary = newSummary('Stop');
    await createDelivery({ credentials: stale, paths: p, summary }).deliver({ scope: 'sessions:light', turns: [] });
    assert.equal(node.refreshes, 1, 'no second token call');
    assert.equal(node.reused, 0, 'the spent refresh token was not presented');
    assert.equal(isRefused(readJson(p.credentials)), false);
    assert.deepEqual(await refreshStored(p, stale), loadCredentials(p), 'the stored tokens are the answer');
    assert.equal(node.refreshes, 1);
  } finally {
    await node.close();
  }
});

test('stored tokens that are newer but expired too are refreshed with the stored refresh token, never the caller\'s', async () => {
  const node = await rotatingNode({ tokenDelayMs: 0 });
  try {
    const { p } = setup(node);
    const stale = loadCredentials(p);
    node.refresh = 'wrt_rotated-elsewhere';
    saveCredentials({ ...stale, accessToken: 'wat_also-expired', refreshToken: 'wrt_rotated-elsewhere', expiresAt: '2020-01-01T00:00:00.000Z' }, p);
    const fresh = await refreshStored(p, stale);
    assert.equal(fresh.accessToken, 'wat_rotated-1');
    assert.deepEqual(node.presented, ['wrt_rotated-elsewhere']);
    assert.equal(readJson(p.credentials).refreshToken, 'wrt_rotated-1');
    assert.equal(node.reused, 0);
  } finally {
    await node.close();
  }
});

test('a caller waits for the process that holds the refresh lock and then takes the tokens it stored', async () => {
  const node = await rotatingNode({ tokenDelayMs: 0 });
  try {
    const { p } = setup(node);
    const held = await acquireAsync(refreshLockPath(p)); // another process is refreshing
    let settled = false;
    const call = nodeCall(p, 'inbox', { session_id: SID }).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, 'it waits for the lock');
    assert.equal(node.refreshes, 0);
    node.valid = 'wat_from-the-holder';
    saveCredentials({ ...loadCredentials(p), accessToken: 'wat_from-the-holder', refreshToken: 'wrt_from-the-holder', expiresAt: new Date(Date.now() + 3600_000).toISOString() }, p);
    held.release();
    assert.equal((await call).ok, true);
    assert.equal(node.refreshes, 0, 'no token call: the holder already refreshed');
    assert.equal(node.tool('inbox')[0].auth, 'Bearer wat_from-the-holder');
  } finally {
    await node.close();
  }
});

/** The pid of a process that has exited. */
function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  return new Promise((resolve) => child.on('exit', () => resolve(child.pid)));
}

for (const [label, holder] of [
  ['of a process that died while holding it', async () => ({ pid: await deadPid(), token: 'dead-holder', at: new Date().toISOString() })],
  ['held longer than any refresh takes (a hung holder, or a pid the OS reused)', async () => ({ pid: process.pid, token: 'hung-holder', at: new Date(Date.now() - REFRESH_LOCK_MAX_HOLD_MS - 1000).toISOString() })],
]) {
  test(`a refresh lock ${label} is taken over`, async () => {
    const node = await rotatingNode({ tokenDelayMs: 0 });
    try {
      const { p } = setup(node);
      writeFileSync(refreshLockPath(p), JSON.stringify(await holder()));
      const started = Date.now();
      assert.equal((await nodeCall(p, 'inbox', { session_id: SID })).ok, true);
      assert.ok(Date.now() - started < 5000, 'taken over at once, not after a wait');
      assert.equal(node.refreshes, 1);
      assert.equal(existsSync(refreshLockPath(p)), false);
    } finally {
      await node.close();
    }
  });
}

test('a revoked grant under the lock: one token call, the connection marked once, then no token call', async () => {
  const node = await rotatingNode({ tokenDelayMs: 0 });
  try {
    node.grant = 'revoked';
    const { p } = setup(node);
    const out = await Promise.all([1, 2, 3, 4].map(() => nodeCall(p, 'inbox', { session_id: SID })));
    for (const r of out) assert.equal(r.ok, false);
    assert.equal(node.refreshes, 1, 'the waiters found the mark and made no token call');
    assert.equal(isRefused(readJson(p.credentials)), true);
    assert.deepEqual(node.presented, [REFRESH]);
    assert.equal((await nodeCall(p, 'inbox', { session_id: SID })).kind, 'not-connected');
    assert.equal(node.refreshes, 1);
  } finally {
    await node.close();
  }
});

test('a refresh for a grant replaced meanwhile (another grantId) makes no token call and stores nothing', async () => {
  const node = await rotatingNode({ tokenDelayMs: 0 });
  try {
    const { p } = setup(node);
    const old = loadCredentials(p);
    saveCredentials({ ...old, grantId: 'g2', accessToken: TOKEN }, p);
    assert.equal(await refreshStored(p, old), null);
    assert.equal(node.refreshes, 0);
    assert.equal(readJson(p.credentials).grantId, 'g2');
  } finally {
    await node.close();
  }
});

test('a refresh for a connection removed meanwhile makes no token call and leaves no directory behind', async () => {
  const node = await rotatingNode({ tokenDelayMs: 0 });
  try {
    const { p } = setup(node);
    const c = loadCredentials(p);
    rmSync(dirname(p.credentials), { recursive: true, force: true });
    assert.equal(await refreshStored(p, c), null);
    assert.equal(node.refreshes, 0);
    assert.equal(existsSync(dirname(p.credentials)), false);
    await assert.rejects(acquireAsync(refreshLockPath(p), { maxWaitMs: 0 }), { code: 'ENOENT' });
    assert.equal(existsSync(dirname(p.credentials)), false, 'the lock never creates the directory');
  } finally {
    await node.close();
  }
});
