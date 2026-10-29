import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanLine, isChecked } from '../scripts/check-no-rulings.mjs';

const flagged = (s) => scanLine(s).length > 0;

test('ruling ids, review-round labels and tracker citations are flagged', () => {
  for (const s of [
    '// bank balances are personal data (R30)',
    '// R183: no write without a switch',
    '/** I-24 says so */',
    "test('R2-F1: it fails', () => {})",
    '// the card draws closed (I-74)',
    '// found in QA #122',
    '// a few words may stand here (QA round 1 on the sign-in PR)',
    '// keep it, QA r12',
    '// per ruling R15 gating stays in the node',
    '// see the rulings index',
    '- **Live proof** (plan track D3).',
    '// the cards pin against it (plan B4.2)',
  ]) assert.ok(flagged(s), s);
});

test('a dated or quoted attribution is flagged, whatever the name', () => {
  for (const s of [
    '// Kari 10.17: no auto-send',
    '// (Kari, 2026-09-29)',
    '// Ola, 10-17',
    "// Kari's call",
    '// Ola decided to keep it',
    '// «Lock it», Kari, verbatim',
  ]) assert.ok(flagged(s), s);
});

test('plain reasons, versions, data and dates without a person are not flagged', () => {
  for (const s of [
    '// the vendor caps a page at 100 rows, so we page',
    'Node 20.11 or newer (Claude Code 2.1.292)',
    "const item = { id: 'I-12', status: 'pr' }",
    "write(`${dir}/inbox/I-5.json`)",
    'RS256, ROOT2 and CR2 are not ids',
    '"R21" is a bus line',
    'a session started 2026-10-01T08:00:00Z',
    '// Codex rollouts, verified 2026-09-29 against the desktop app',
    '// the plan is to page; a second client is ruled out by the token scope',
    'Since 2026-01-01 the field is required.',
  ]) assert.ok(!flagged(s), s);
});

test('the scanner and its test are not scanned', () => {
  assert.equal(isChecked('scripts/check-no-rulings.mjs'), false);
  assert.equal(isChecked('test/check-no-rulings.test.js'), false);
  assert.equal(isChecked('lib/distil.js'), true);
  assert.equal(isChecked('test/fixtures/session.jsonl'), false);
});

test('a name with a spelled-out date, or near a date in parentheses, is flagged; «Plan» is a citation in any case', () => {
  for (const s of [
    '// Kari wrote this (2026-10-29)',
    '// (Ola, Oct 21)',
    '// Kari, 21 October',
    '// Ola, 3. mai',
    '// Kari 21 Oct: keep it',
    '- Plan B4.2 says so',
  ]) assert.ok(flagged(s), s);
});

test('an OS, runtime or database version next to a capitalised name is not a dated attribution', () => {
  for (const s of [
    'runs on Ubuntu 22.04',
    'Postgres 16.10 is needed',
    'Debian 12.05 image',
    'PostgreSQL 15.04 or newer',
    'Python 3.12 and Fedora 39',
    'Alpine 03.12 base',
    '// the cache may fail, 2 may retry',
  ]) assert.ok(!flagged(s), s);
});
