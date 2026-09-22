// Mutation harness for lib/redact.js: weakens ONE family's pattern at a time (replaces the
// regex with /(?!)/, which matches nothing), runs test/redact.test.js, and demands that the run
// goes RED. A suite that stays green through a weakening proves nothing about that family.
// The file is restored byte-for-byte in `finally` and the restoration is verified.
//
// Run directly:  node test/redact-weaken.js
// Under `node --test` this file registers one skipped test and does nothing else: it rewrites
// lib/redact.js while running, and the runner executes files in parallel.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const target = join(root, 'lib', 'redact.js');
const suite = join(root, 'test', 'redact.test.js');

if (process.env.NODE_TEST_CONTEXT) {
  const { test } = await import('node:test');
  test('redact-weaken is a harness, run it directly: node test/redact-weaken.js', { skip: true });
} else {
  process.exitCode = await main();
}

async function main() {
  const { FAMILIES } = await import('../lib/redact.js');
  const original = readFileSync(target);
  const text = original.toString('latin1'); // byte-preserving round trip, whatever the dialect
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const rows = [];
  let allGood = true;

  try {
    for (const family of FAMILIES) {
      const anchor = `name: '${family.name}'`;
      const idx = lines.map((l, i) => (l.includes(anchor) ? i : -1)).filter((i) => i >= 0);
      if (idx.length !== 1) throw new Error(`anchor for ${family.name} matched ${idx.length} lines, expected exactly 1`);
      const line = lines[idx[0]];
      const m = /^(.*\bre: )(.+?)((?:, validate: \w+)? \},?)$/.exec(line);
      if (!m) throw new Error(`could not find the regex on the ${family.name} line`);
      const weakened = [...lines];
      weakened[idx[0]] = `${m[1]}/(?!)/g${m[3]}`;
      writeFileSync(target, Buffer.from(weakened.join(eol), 'latin1'));
      const run = runSuite();
      const red = run.status !== 0 && run.failed.length > 0;
      if (!red) allGood = false;
      rows.push({ name: family.name, red, failed: run.failed });
    }

    writeFileSync(target, Buffer.concat([original, Buffer.from(`${eol}// weaken null control${eol}`, 'latin1')]));
    const nullRun = runSuite();
    const nullGreen = nullRun.status === 0 && nullRun.failed.length === 0;
    if (!nullGreen) allGood = false;
    rows.push({ name: '(null control: comment appended)', red: !nullGreen, failed: nullRun.failed, expectGreen: true });
  } finally {
    writeFileSync(target, original);
    const restored = readFileSync(target);
    if (!restored.equals(original)) {
      process.stderr.write('FATAL: lib/redact.js was not restored byte-for-byte\n');
      return 2;
    }
  }

  for (const r of rows) {
    const verdict = r.expectGreen ? (r.red ? 'RED (WRONG)' : 'GREEN (as required)') : (r.red ? 'RED (as required)' : 'GREEN (WRONG)');
    const detail = r.failed.length ? ` ${r.failed.length} failing, e.g. "${r.failed[0]}"` : '';
    process.stdout.write(`${r.name.padEnd(36)} ${verdict}${detail}\n`);
  }
  process.stdout.write(allGood ? 'redact-weaken: every family reddens, null control green\n' : 'redact-weaken: FAILED\n');
  return allGood ? 0 : 1;
}

function runSuite() {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite], { encoding: 'utf8', cwd: root });
  const failed = [];
  for (const line of (run.stdout ?? '').split('\n')) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(line);
    if (m) failed.push(m[1].trim());
  }
  return { status: run.status, failed };
}
