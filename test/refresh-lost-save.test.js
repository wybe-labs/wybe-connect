// A refresh the authorization server accepted must never be lost because saving it failed. The refresh
// token is single-use: once the server has rotated it, the old one on disk is spent. If the process that
// rotated cannot write the new tokens (on Windows a rename over credentials.json can stay busy while
// many processes wake at once and read it), the next process must not present the spent token: that
// is refused for good (invalid_grant) and marks a live grant as refused. Seen on a laptop waking from
// sleep: one refresh accepted, the new tokens never on disk, two refusals of the old token, the
// connection marked refused although the grant was alive at the authorization server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { connectionPaths } from '../lib/connections.js';
import { saveCredentials, readJson, isRefused, writeJsonPrivate, markRefused } from '../lib/home.js';
import { nodeCall } from '../lib/bridge.js';
import { refreshStored, rotatedPath, refreshLockPath } from '../lib/refresh.js';
import { startFakeNode, grantFor, REFRESH } from './fixtures/fake-node.mjs';

const SID = 'sess-lost-save-0001';
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const LIB = (f) => pathToFileURL(join(import.meta.dirname, '..', 'lib', f)).href;

/** A node whose token endpoint rotates and detects reuse, that no longer takes the stored access token. */
async function rotatingNode() {
  const node = await startFakeNode({ valid: 'wat_expired-elsewhere' });
  node.grant = 'rotating';
  return node;
}

/** A save that fails as on Windows when the rename over credentials.json stays busy: writeJsonPrivate gives up after its tries. */
function busySave() {
  const s = { renames: 0 };
  s.save = (c, p) => writeJsonPrivate(p.credentials, { version: 1, ...c }, {
    renameImpl: () => {
      s.renames += 1;
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    },
  });
  return s;
}

function setup(node, over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-lost-save-'));
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
  let line;
  try {
    const out = await nodeCall(p, 'inbox', { session_id: ${JSON.stringify(SID)} });
    line = { ok: out.ok, kind: out.kind ?? null };
  } catch (err) {
    line = { ok: false, kind: 'threw' };
  }
  process.stdout.write('RESULT ' + JSON.stringify(line) + '\\n');
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

test('a refresh whose save failed is not lost: the next process uses the rotated tokens and never presents the spent one', async () => {
  const node = await rotatingNode();
  let blocked;
  try {
    const { root, p } = setup(node);
    const a = caller(root);
    await a.ready;
    // Process A cannot write credentials.json: its temp file path is taken (as a rename that stays busy would).
    blocked = `${p.credentials}.${a.child.pid}.tmp`;
    mkdirSync(blocked);
    a.child.stdin.end('go\n');
    await a.result;
    assert.equal(node.refreshes, 1, 'A refreshed once, and the server rotated the grant');

    // Process B (this one) meets the same expired access token with the old tokens on disk.
    const out = await nodeCall(p, 'inbox', { session_id: SID });
    assert.equal(node.reused, 0, 'the spent refresh token was never presented again');
    assert.equal(node.refreshes, 1, 'no second token call: B used the tokens A was given');
    assert.equal(out.ok, true);
    assert.equal(node.tool('inbox').at(-1).auth, 'Bearer wat_rotated-1');
    const onDisk = readJson(p.credentials);
    assert.equal(isRefused(onDisk), false, 'a live grant is never marked refused');
    assert.equal(onDisk.accessToken, 'wat_rotated-1');
    assert.equal(onDisk.refreshToken, 'rtk_rotated-1');
    assert.equal(existsSync(rotatedPath(p)), false, 'the kept tokens are removed once they are on disk');
  } finally {
    if (blocked) rmSync(blocked, { recursive: true, force: true });
    await node.close();
  }
});

// Kept tokens from another grant (a new sign-in replaced it) and kept tokens that replaced another
// refresh token of the same grant: neither is used; the refresh token on disk is presented as usual.
for (const [what, kept] of [
  ['another grant', (c) => ({ grantId: 'another-grant', from: sha256(c.refreshToken) })],
  ['another refresh token of the same grant', (c) => ({ grantId: c.grantId, from: sha256('rtk_some-earlier-one') })],
]) {
  test(`kept rotated tokens are adopted only for the same grant and the refresh token they replaced: not for ${what}`, async () => {
    const node = await rotatingNode();
    try {
      const { p } = setup(node);
      const c = readJson(p.credentials);
      writeFileSync(rotatedPath(p), JSON.stringify({ ...kept(c), tokens: { accessToken: 'wat_other', refreshToken: 'rtk_other' } }));
      const fresh = await refreshStored(p, c);
      assert.equal(node.refreshes, 1);
      assert.deepEqual(node.presented, [REFRESH]);
      assert.equal(fresh.accessToken, 'wat_rotated-1');
      assert.equal(readJson(p.credentials).refreshToken, 'rtk_rotated-1');
    } finally {
      await node.close();
    }
  });
}

const later1h = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

test('a refused connection stays refused without kept tokens, or with kept tokens that replaced another refresh token', async () => {
  for (const kept of [null, (c) => ({ grantId: c.grantId, from: sha256('rtk_some-earlier-one') })]) {
    const node = await rotatingNode();
    try {
      const { p } = setup(node);
      const c = readJson(p.credentials);
      saveCredentials({ ...c, refusedAt: '2026-01-01T00:00:00.000Z' }, p);
      if (kept) writeFileSync(rotatedPath(p), JSON.stringify({ ...kept(c), tokens: { accessToken: 'wat_kept', refreshToken: 'rtk_kept', expiresAt: later1h() } }));
      assert.equal(await refreshStored(p, c), null);
      assert.equal(node.refreshes, 0);
      assert.equal(isRefused(readJson(p.credentials)), true);
    } finally {
      await node.close();
    }
  }
});

test('a connection refused for a refresh token that kept tokens replaced is live again: the kept tokens are adopted and refusedAt cleared', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    saveCredentials({ ...c, refusedAt: '2026-01-01T00:00:00.000Z' }, p);
    writeFileSync(rotatedPath(p), JSON.stringify({ grantId: c.grantId, from: sha256(REFRESH), tokens: { accessToken: 'wat_kept', refreshToken: 'rtk_kept', expiresAt: later1h() } }));
    const out = await refreshStored(p, c);
    assert.equal(out?.accessToken, 'wat_kept');
    assert.equal(node.refreshes, 0);
    const onDisk = readJson(p.credentials);
    assert.equal(isRefused(onDisk), false);
    assert.equal(onDisk.refreshToken, 'rtk_kept');
    assert.equal(existsSync(rotatedPath(p)), false);
  } finally {
    await node.close();
  }
});

test('a takeover race heals: the new holder presented the spent token and marked the connection refused, then the old holder got the 200', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    const lockFile = refreshLockPath(p);
    const fetchImpl = async (...args) => {
      const r = await globalThis.fetch(...args); // the server rotates for this holder
      // meanwhile another process took the lock over, presented the spent token, and marked the connection refused
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'taken-over', at: Date.now() }));
      markRefused(p, readJson(p.credentials));
      return r;
    };
    const fresh = await refreshStored(p, c, { fetchImpl });
    rmSync(lockFile, { force: true });
    assert.equal(fresh.accessToken, 'wat_rotated-1');
    const onDisk = readJson(p.credentials);
    assert.equal(isRefused(onDisk), false, 'the live grant is not left refused');
    assert.equal(onDisk.refreshToken, 'rtk_rotated-1');
    assert.equal(existsSync(rotatedPath(p)), false);
  } finally {
    await node.close();
  }
});

test('the other side of that race heals too: a refusal of a token that a refresh kept tokens for, written while the token call ran, adopts them', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    node.refresh = 'rtk_issued-to-the-other-holder'; // REFRESH is already spent at the server
    const fetchImpl = (...args) => {
      // the holder whose lock was taken over gets its 200 and keeps the tokens
      writeFileSync(rotatedPath(p), JSON.stringify({ grantId: c.grantId, from: sha256(REFRESH), tokens: { accessToken: 'wat_kept', refreshToken: 'rtk_issued-to-the-other-holder', expiresAt: later1h() } }));
      return globalThis.fetch(...args);
    };
    const out = await refreshStored(p, c, { fetchImpl });
    assert.equal(node.reused, 1, 'this holder presented the spent token once');
    assert.equal(out?.accessToken, 'wat_kept');
    const onDisk = readJson(p.credentials);
    assert.equal(isRefused(onDisk), false, 'the live grant is not left refused');
    assert.equal(onDisk.refreshToken, 'rtk_issued-to-the-other-holder');
    assert.equal(existsSync(rotatedPath(p)), false);
  } finally {
    await node.close();
  }
});

test('Windows: a rename that stays busy until writeJsonPrivate gives up loses no rotation', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    const busy = busySave();
    const fresh = await refreshStored(p, c, { save: busy.save });
    assert.equal(fresh.accessToken, 'wat_rotated-1', 'the caller still gets the tokens for its call');
    assert.ok(busy.renames >= 12 * 2, 'every save attempt ran writeJsonPrivate to the end of its tries');
    assert.equal(readJson(p.credentials).refreshToken, REFRESH, 'credentials.json still holds the spent token');
    assert.equal(existsSync(rotatedPath(p)), true, 'the rotated tokens are kept');

    const again = await refreshStored(p, c);
    assert.equal(node.reused, 0, 'the spent refresh token was never presented again');
    assert.equal(node.refreshes, 1);
    assert.equal(again.accessToken, 'wat_rotated-1');
    assert.equal(readJson(p.credentials).refreshToken, 'rtk_rotated-1');
    assert.equal(existsSync(rotatedPath(p)), false);
  } finally {
    await node.close();
  }
});

test('the rotated tokens are kept before credentials.json is written, so a process that dies while saving loses nothing', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    let keptAtSave;
    const fresh = await refreshStored(p, c, {
      save: (x, q) => {
        if (keptAtSave === undefined) keptAtSave = existsSync(rotatedPath(q)) ? readJson(rotatedPath(q)) : null;
        saveCredentials(x, q);
      },
    });
    assert.equal(fresh.accessToken, 'wat_rotated-1');
    assert.equal(keptAtSave?.tokens?.refreshToken, 'rtk_rotated-1', 'kept on disk before the first save attempt');
    assert.equal(readJson(p.credentials).refreshToken, 'rtk_rotated-1');
    assert.equal(existsSync(rotatedPath(p)), false, 'and removed once credentials.json holds them');
  } finally {
    await node.close();
  }
});

/** A read that fails as a busy file on Windows for `path` while `busy()` says so. */
const busyRead = (path, busy) => (q, ...rest) => {
  if (q === path && busy()) throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
  return readFileSync(q, ...rest);
};

for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
  test(`a kept file that is there but ${code} on read is never taken for «none»: no refresh token is presented on that call`, async () => {
    const node = await rotatingNode();
    try {
      const { p } = setup(node);
      const c = readJson(p.credentials);
      writeFileSync(rotatedPath(p), JSON.stringify({ grantId: c.grantId, from: sha256(REFRESH), tokens: { accessToken: 'wat_kept', refreshToken: 'rtk_kept' } }));
      const read = (q, ...rest) => {
        if (q === rotatedPath(p)) throw Object.assign(new Error(code), { code });
        return readFileSync(q, ...rest);
      };
      assert.equal(await refreshStored(p, c, { read }), null);
      assert.equal(node.refreshes, 0, 'the refresh token on disk may be spent: not presented');
      assert.equal(isRefused(readJson(p.credentials)), false);
    } finally {
      await node.close();
    }
  });
}

for (const [what, make] of [
  ['empty (power lost after the rename)', (path) => writeFileSync(path, '')],
  ['half written', (path) => writeFileSync(path, '{"grantId": "')],
  ['a directory', (path) => mkdirSync(path)],
]) {
  test(`a kept file that is ${what} never blocks the connection, not even a new sign-in: it is set aside`, async () => {
    const node = await rotatingNode();
    try {
      const { p } = setup(node);
      make(rotatedPath(p));
      saveCredentials({ ...readJson(p.credentials), grantId: 'new-grant-after-sign-in' }, p);
      const c = readJson(p.credentials);
      const fresh = await refreshStored(p, c);
      assert.equal(node.refreshes, 1);
      assert.equal(fresh?.accessToken, 'wat_rotated-1');
      assert.equal(readJson(p.credentials).refreshToken, 'rtk_rotated-1');
      assert.equal(existsSync(rotatedPath(p)), false, 'set aside');
      assert.equal(readdirSync(dirname(p.credentials)).some((n) => n.startsWith('credentials.rotated.json.unreadable-')), true);
    } finally {
      await node.close();
    }
  });
}

test('credentials.json busy when the 200 lands: the tokens are kept (not lost, not written blind), and the next refresh adopts them', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    let busy = false;
    const fetchImpl = (...args) => { busy = true; return globalThis.fetch(...args); };
    const fresh = await refreshStored(p, c, { fetchImpl, read: busyRead(p.credentials, () => busy) });
    assert.equal(fresh.accessToken, 'wat_rotated-1');
    assert.equal(existsSync(rotatedPath(p)), true, 'kept');
    assert.equal(readJson(p.credentials).refreshToken, REFRESH, 'not written over a file it could not read');
    const again = await refreshStored(p, c);
    assert.equal(node.reused, 0);
    assert.equal(node.refreshes, 1);
    assert.equal(again.accessToken, 'wat_rotated-1');
    assert.equal(readJson(p.credentials).refreshToken, 'rtk_rotated-1');
  } finally {
    await node.close();
  }
});

test('kept tokens whose access token has expired (a laptop asleep for hours) are refreshed at once with the kept refresh token', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    await refreshStored(p, c, { save: busySave().save });
    assert.equal(existsSync(rotatedPath(p)), true);

    const later = Date.now() + 2 * 60 * 60 * 1000;
    const fresh = await refreshStored(p, c, { now: () => later });
    assert.equal(node.reused, 0, 'the spent refresh token was never presented again');
    assert.deepEqual(node.presented, [REFRESH, 'rtk_rotated-1']);
    assert.equal(fresh.accessToken, 'wat_rotated-2', 'the caller gets a live access token, not the expired kept one');
    assert.ok(Date.parse(fresh.expiresAt) > later);
    const onDisk = readJson(p.credentials);
    assert.equal(onDisk.refreshToken, 'rtk_rotated-2');
    assert.equal(isRefused(onDisk), false);
    assert.equal(existsSync(rotatedPath(p)), false);
  } finally {
    await node.close();
  }
});

test('a holder whose lock was taken over keeps the rotated tokens but never writes credentials.json; the next holder adopts them', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    const lockFile = refreshLockPath(p);
    // While the token call runs, another process takes the lock over (as after REFRESH_LOCK_MAX_HOLD_MS).
    const fetchImpl = (...args) => {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'taken-over', at: Date.now() }));
      return globalThis.fetch(...args);
    };
    const fresh = await refreshStored(p, c, { fetchImpl });
    assert.equal(fresh.accessToken, 'wat_rotated-1');
    assert.equal(readJson(p.credentials).refreshToken, REFRESH, 'not written without the lock');
    assert.equal(existsSync(rotatedPath(p)), true, 'kept for the holder that has the lock');

    rmSync(lockFile); // that holder lets go
    const again = await refreshStored(p, c);
    assert.equal(node.reused, 0);
    assert.equal(node.refreshes, 1);
    assert.equal(again.accessToken, 'wat_rotated-1');
    assert.equal(readJson(p.credentials).refreshToken, 'rtk_rotated-1');
  } finally {
    await node.close();
  }
});

test('a keep whose temp file cannot be written still keeps: the chain R0 → R1 → R2 → R3 with every save busy never presents a spent token', async () => {
  const node = await rotatingNode();
  let blocked;
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    const busy = busySave();
    await refreshStored(p, c, { save: busy.save }); // R0 → R1, kept
    blocked = `${rotatedPath(p)}.${process.pid}.tmp`;
    mkdirSync(blocked); // the keep's temp file + rename cannot be done
    const t2 = Date.now() + 2 * 60 * 60 * 1000;
    await refreshStored(p, c, { save: busy.save, now: () => t2 }); // R1 → R2: kept in place of the superseded R1
    const t3 = t2 + 2 * 60 * 60 * 1000;
    const out = await refreshStored(p, c, { now: () => t3 }); // R2 → R3, saved
    assert.deepEqual(node.presented, [REFRESH, 'rtk_rotated-1', 'rtk_rotated-2']);
    assert.equal(node.reused, 0);
    assert.equal(out.accessToken, 'wat_rotated-3');
    const onDisk = readJson(p.credentials);
    assert.equal(isRefused(onDisk), false);
    assert.equal(onDisk.refreshToken, 'rtk_rotated-3');
  } finally {
    if (blocked) rmSync(blocked, { recursive: true, force: true });
    await node.close();
  }
});


test('kept tokens the server refuses for good end the connection: no token call after that refusal, and nothing kept is left to present', async () => {
  const node = await rotatingNode();
  try {
    const { p } = setup(node);
    const c = readJson(p.credentials);
    await refreshStored(p, c, { save: busySave().save }); // R0 → R1, kept, the save did not hold
    assert.equal(existsSync(rotatedPath(p)), true);
    node.grant = 'revoked'; // the grant is dead at the server
    const later = Date.now() + 2 * 60 * 60 * 1000;
    assert.equal(await refreshStored(p, c, { now: () => later }), null);
    assert.deepEqual(node.presented, [REFRESH, 'rtk_rotated-1'], 'the kept refresh token was presented once');
    assert.equal(isRefused(readJson(p.credentials)), true);
    assert.equal(existsSync(rotatedPath(p)), false, 'the refused kept tokens are gone');
    for (let i = 1; i <= 5; i++) assert.equal(await refreshStored(p, c, { now: () => later + i }), null);
    assert.equal(node.presented.length, 2, 'no token call after the refusal');
  } finally {
    await node.close();
  }
});
