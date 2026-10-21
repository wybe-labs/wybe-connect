// Append-only record files with a checksum per line, for the distil run's outbox and the node's
// acknowledgements (lib/distil.js). A line is `<json>\t<first 16 hex of sha256(json)>\n`, written
// with one write and an fsync. A reader trusts only whole lines whose checksum matches: a line cut
// short (disk full, a process killed mid-append) or altered is counted in `torn` and never read
// as a record, and it never hides the records around it. What a torn line meant is the caller's
// call; distil.js treats it as "not there" (an ack that is missing, a record the outbox lacks).

import { createHash } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, mkdirSync, fstatSync, readSync } from 'node:fs';
import { dirname } from 'node:path';

const sum = (json) => createHash('sha256').update(json).digest('hex').slice(0, 16);

export function encodeLine(record) {
  const json = JSON.stringify(record);
  return `${json}\t${sum(json)}\n`;
}

/** Appends one record durably. A torn tail left by an earlier writer is closed with a newline first. */
export function appendRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, 'a+', 0o600);
  try {
    const { size } = fstatSync(fd);
    let lead = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    writeSync(fd, lead + encodeLine(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** { records, torn }: every whole, checksummed line in order, and how many lines were not. */
export function readRecords(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { records: [], torn: 0 };
    throw err;
  }
  const lines = text.split('\n');
  const tail = lines.pop(); // '' when the file ends on a newline; otherwise a line cut short
  const records = [];
  let torn = tail === '' ? 0 : 1;
  for (const line of lines) {
    if (line === '') continue;
    const tab = line.lastIndexOf('\t');
    const json = tab < 0 ? null : line.slice(0, tab);
    if (json === null || sum(json) !== line.slice(tab + 1)) {
      torn += 1;
      continue;
    }
    try {
      records.push(JSON.parse(json));
    } catch {
      torn += 1;
    }
  }
  return { records, torn };
}
