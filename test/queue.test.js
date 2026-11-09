import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enqueue, drain, prune, size, MAX_AGE_MS, MAX_BYTES } from '../lib/queue.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'wybe-connect-queue-'));

test('enqueue creates the directory and one file per item, oldest first by name', () => {
  const dir = join(fresh(), 'queue');
  assert.equal(existsSync(dir), false);
  enqueue(dir, { n: 1 }, { now: 1000 });
  enqueue(dir, { n: 2 }, { now: 2000 });
  enqueue(dir, { n: 3 }, { now: 1500 });
  const names = readdirSync(dir).sort();
  assert.equal(names.length, 3);
  assert.deepEqual(size(dir).count, 3);
  assert.ok(names[0].startsWith('000000000001000-'));
  assert.ok(names[2].startsWith('000000000002000-'));
});

test('drain sends oldest first, removes what was accepted, stops at the first refusal', async () => {
  const dir = fresh();
  enqueue(dir, { n: 1 }, { now: 1000 });
  enqueue(dir, { n: 2 }, { now: 2000 });
  enqueue(dir, { n: 3 }, { now: 3000 });
  const seen = [];
  const r = await drain(dir, async (item) => {
    seen.push(item.n);
    return item.n !== 2;
  });
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(r, { sent: 1, remaining: 2 });
  assert.equal(size(dir).count, 2);
  const r2 = await drain(dir, async () => true);
  assert.deepEqual(r2, { sent: 2, remaining: 0 });
  assert.equal(size(dir).count, 0);
});

test('a thrown send stops the drain and keeps the item', async () => {
  const dir = fresh();
  enqueue(dir, { n: 1 }, { now: 1000 });
  await assert.rejects(drain(dir, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(size(dir).count, 1);
});

test('items older than the age bound are dropped on the next enqueue', () => {
  const dir = fresh();
  const t0 = 1_700_000_000_000;
  enqueue(dir, { n: 'old' }, { now: t0 });
  const r = enqueue(dir, { n: 'new' }, { now: t0 + MAX_AGE_MS + 1 });
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].reason, 'age');
  assert.equal(size(dir).count, 1);
});

test('the size bound drops the oldest until the queue fits; the bound is 50 MB and 7 days', () => {
  assert.equal(MAX_BYTES, 50 * 1024 * 1024);
  assert.equal(MAX_AGE_MS, 7 * 24 * 3600 * 1000);
  const dir = fresh();
  const big = 'x'.repeat(1000);
  enqueue(dir, { n: 1, big }, { now: 1000, maxBytes: 2500 });
  enqueue(dir, { n: 2, big }, { now: 2000, maxBytes: 2500 });
  const r = enqueue(dir, { n: 3, big }, { now: 3000, maxBytes: 2500 });
  assert.deepEqual(r.dropped.map((d) => d.reason), ['size']);
  assert.ok(r.dropped[0].name.startsWith('000000000001000-'), 'the oldest goes first');
  assert.equal(size(dir).count, 2);
});

test('POSITIVE CONTROL: without bounds nothing is dropped', () => {
  const dir = fresh();
  const big = 'x'.repeat(1000);
  for (let i = 0; i < 3; i++) enqueue(dir, { i, big }, { now: 1000 + i });
  assert.deepEqual(prune(dir, { now: 5000 }), []);
  assert.equal(size(dir).count, 3);
});

test('prune on a missing directory is a no-op', () => {
  assert.deepEqual(prune(join(fresh(), 'missing')), []);
});
