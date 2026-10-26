// On Windows a rename over a file another process is reading or replacing at that moment fails
// with EPERM, EACCES or EBUSY for a few milliseconds. An atomic write retries it instead of
// failing the hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonPrivate } from '../lib/home.js';

test('an atomic write retries a rename that is busy for a moment, then lands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-home-write-'));
  try {
    const target = join(dir, 'state.json');
    let fails = 3;
    const renameImpl = (a, b) => {
      if (fails-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: ['EPERM', 'EACCES', 'EBUSY'][fails % 3] });
      renameSync(a, b);
    };
    writeJsonPrivate(target, { ok: 1 }, { renameImpl });
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { ok: 1 });
    assert.deepEqual(readdirSync(dir), ['state.json'], 'no temp file left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an atomic write gives up on a rename that stays busy, leaving no temp file, and never retries other errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-home-write-'));
  try {
    const target = join(dir, 'state.json');
    let calls = 0;
    assert.throws(() => writeJsonPrivate(target, { ok: 1 }, { renameImpl: () => { calls += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } }), /busy/);
    assert.ok(calls > 1 && calls <= 20, `tried ${calls} times`);
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(dir), []);
    calls = 0;
    assert.throws(() => writeJsonPrivate(target, { ok: 1 }, { renameImpl: () => { calls += 1; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }), /gone/);
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
