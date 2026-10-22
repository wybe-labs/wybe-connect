import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { withLock, LOCK_UNREADABLE_MS, _internals } from '../lib/lock.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'wybe-connect-lock-')), 'distil.lock');
const LOCK_URL = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'lock.js')).href;

/** A real process that takes the lock and holds it for `ms`, then prints DONE. */
function holder(file, ms) {
  const src = `import { withLock } from ${JSON.stringify(LOCK_URL)};
withLock(${JSON.stringify(file)}, () => { process.stdout.write('HOLDING\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms}); });
process.stdout.write('DONE\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let out = '';
  const holding = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('HOLDING')) resolve(); }));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return { child, holding, exited };
}

test('the lock is exclusive while held and gone after', () => {
  const file = fresh();
  const v = withLock(file, () => {
    assert.ok(existsSync(file));
    assert.throws(() => withLock(file, () => 1, { tries: 2, waitMs: 5 }), { code: 'ELOCKBUSY' });
    return 7;
  });
  assert.equal(v, 7);
  assert.equal(existsSync(file), false);
});

test('a throw inside the lock releases it', () => {
  const file = fresh();
  assert.throws(() => withLock(file, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(file), false);
});

test('R4-7: a live holder slower than any timeout is never taken over (real process, 6 s)', async () => {
  const file = fresh();
  const h = holder(file, 6000);
  await h.holding;
  const t0 = Date.now();
  // 7 s of trying: longer than the holder holds, so the contender gets it only after the holder let go.
  let gotAt = null;
  while (Date.now() - t0 < 9000 && gotAt === null) {
    try {
      withLock(file, () => { gotAt = Date.now(); }, { tries: 1, waitMs: 1 });
    } catch (err) {
      assert.equal(err.code, 'ELOCKBUSY');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await h.exited;
  assert.ok(gotAt !== null, 'the contender got the lock once the holder released it');
  assert.ok(gotAt - t0 >= 5500, `the contender waited for the live holder (${gotAt - t0} ms)`);
});

test('a dead holder\'s lock is taken over at once', () => {
  const file = fresh();
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify({ pid: Number(dead.stdout), token: 'old', at: new Date().toISOString() }));
  assert.equal(withLock(file, () => 'mine', { tries: 1, waitMs: 1 }), 'mine');
});

test('fencing: a holder whose lock was replaced sees it, so it can refuse to write', () => {
  const file = fresh();
  const seen = withLock(file, ({ stillHeld }) => {
    const before = stillHeld();
    writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'someone-else', at: new Date().toISOString() }));
    return [before, stillHeld()];
  });
  assert.deepEqual(seen, [true, false]);
  assert.ok(existsSync(file), 'the holder that lost its lock does not delete the new holder\'s lock');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'someone-else');
});

test('a reaper that judged an old empty lock never deletes the new, still-empty lock that replaced it (#4\'s second R4-7 race)', () => {
  const file = fresh();
  writeFileSync(file, '');
  const old = (Date.now() - LOCK_UNREADABLE_MS - 1000) / 1000;
  utimesSync(file, old, old);
  const seen = _internals.readHolder(file);
  assert.ok(_internals.reapable(seen, Date.now(), () => false), 'precondition: the old empty lock is reapable');
  // The old holder lets go; the next one creates the lock and has not written its pid yet.
  unlinkSync(file);
  writeFileSync(file, '');
  _internals.reap(file, seen);
  assert.ok(existsSync(file), 'the new holder\'s lock is still there');
});

test('an unreadable lock is busy while young and taken over once old (a holder that died before writing its pid)', () => {
  const file = fresh();
  writeFileSync(file, '');
  assert.throws(() => withLock(file, () => 1, { tries: 1, waitMs: 1 }), { code: 'ELOCKBUSY' });
  const old = (Date.now() - LOCK_UNREADABLE_MS - 1000) / 1000;
  utimesSync(file, old, old);
  assert.equal(withLock(file, () => 2, { tries: 1, waitMs: 1 }), 2);
});
