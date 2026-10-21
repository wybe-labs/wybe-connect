import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendRecord, readRecords, encodeLine } from '../lib/ledger.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'wybe-connect-ledger-')), 'run.acks');

test('records come back in order, each line carries its own checksum', () => {
  const file = fresh();
  appendRecord(file, { seq: 1, ok: true });
  appendRecord(file, { seq: 2, ok: true });
  assert.deepEqual(readRecords(file), { records: [{ seq: 1, ok: true }, { seq: 2, ok: true }], torn: 0 });
  const [line] = readFileSync(file, 'utf8').split('\n');
  assert.match(line, /^\{.*\}\t[0-9a-f]{16}$/);
});

test('a missing file is no records, not torn', () => {
  assert.deepEqual(readRecords(join(tmpdir(), 'wybe-connect-no-such-file.acks')), { records: [], torn: 0 });
});

test('R4-8: a torn last line is counted as torn and never hides the records before it', () => {
  const file = fresh();
  appendRecord(file, { seq: 1, ok: false });
  appendRecord(file, { seq: 2, ok: true });
  appendFileSync(file, '{"seq":3,"ok":tr');
  const out = readRecords(file);
  assert.deepEqual(out.records, [{ seq: 1, ok: false }, { seq: 2, ok: true }]);
  assert.equal(out.torn, 1);
});

test('a line whose checksum does not match is torn, wherever it is', () => {
  const file = fresh();
  appendRecord(file, { seq: 1 });
  const good = encodeLine({ seq: 2 });
  appendFileSync(file, good.replace('"seq":2', '"seq":9'));
  appendRecord(file, { seq: 3 });
  const out = readRecords(file);
  assert.deepEqual(out.records, [{ seq: 1 }, { seq: 3 }]);
  assert.equal(out.torn, 1);
});

test('a complete line after a torn tail is still read (the next append starts on a new line)', () => {
  const file = fresh();
  appendRecord(file, { seq: 1 });
  appendFileSync(file, '{"seq":2');
  appendRecord(file, { seq: 3 });
  const out = readRecords(file);
  assert.deepEqual(out.records, [{ seq: 1 }, { seq: 3 }]);
  assert.equal(out.torn, 1);
});

test('valid JSON without a checksum is torn, not trusted', () => {
  const file = fresh();
  writeFileSync(file, '{"seq":1,"ok":true}\n');
  assert.deepEqual(readRecords(file), { records: [], torn: 1 });
});
