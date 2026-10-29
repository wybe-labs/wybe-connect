#!/usr/bin/env node
/**
 * No rulings in the code. Fails on numbered decision ids, tracker citations and dated «who said so»
 * attributions in the lines a change adds. CI's "checks" job.
 *
 * Why: a comment citing «R183», «I-24», «QA #12», «plan B4.2» or «Kari 10.17: ...» reads as a
 * standing constraint that nobody outside the team can check, and it keeps an old decision alive
 * against what is wanted now. The reason a line exists belongs in plain words next to it; who decided
 * it lives in git history and pull requests.
 *
 * What counts (reported as file:line and the kind):
 *   ruling id      R + 2-3 digits (R183), a review-round label (R2-F1), I-<n> (I-24), N-R<n>, D-<x>-<n>;
 *                  not when the id is a whole quoted token ("R21", 'I-12') or a file name (I-5.json)
 *   citation       "ruling R.."/"rulings index|file|list|log", "QA #12", "QA round 3", "plan [track] B4.2"
 *   attribution    a capitalised name next to a calendar date ("Kari 10.17:", "(Ola, 2026-09-29)",
 *                  "Ola, Oct 21", "Kari, 3. mai"), a name that wrote or said something on a date
 *                  ("Kari wrote this (2026-10-29)", not "Tests added for 2026-01-01 dates"), a
 *                  possessive decision word ("Kari's call"),
 *                  "Ola decided|ruled", a quote "verbatim"
 *
 * Names are matched by shape, not from a list: this repository is public, and a list of the team's
 * names would be the very leak the scan exists to stop. Product, platform and calendar words that
 * look like names (Node 20.11, Ubuntu 22.04, Since 2026-01-01) are in NOT_NAMES.
 *
 *   node scripts/check-no-rulings.mjs                 # added since the base (as scripts/leak-scan.mjs)
 *   node scripts/check-no-rulings.mjs --base <ref>    # added since <ref>
 *   node scripts/check-no-rulings.mjs --all           # every tracked file, reported, never failing
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { addedLines, baseArg, findBase } from './leak-scan.mjs';

const NAME = String.raw`(?<![\p{L}\d'’.-])(\p{Lu}\p{Ll}+)`;
// A real calendar date: dd.mm or mm.dd (10.17, 23.10), 2026-09-29, 10-17, a month by name (Oct 21,
// 21 October, 3. mai). Not a time range, a version (2.1.292) or a timestamp (2026-10-01T08:00).
// English month names count only capitalised, so "2 may retry" is not a date.
const MONTH_EN = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const MONTH_NB = '(?:januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)';
const DATE = String.raw`(?:(?:0[1-9]|[12]\d|3[01])[./](?:0[1-9]|1[0-2])|(?:0[1-9]|1[0-2])[./](?:0[1-9]|[12]\d|3[01]))(?![\d.])(?![-–]\d{1,2}[.:]\d)` +
  String.raw`|20\d\d-\d\d-\d\d(?![T\d])|(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d-])` +
  String.raw`|${MONTH_EN}\.?\s+(?:[1-9]|[12]\d|3[01])(?![\d:.])|(?:[1-9]|[12]\d|3[01])\.?\s+(?:${MONTH_EN}|${MONTH_NB})(?![A-Za-z])`;
const DECISION_WORD = '(?:ruling|call|decision|verdict|word|words|brief|instruction|instructions|order|orders|requirement|ask|request)';
const VERB = '(?:ruled|decided|insisted|approved|confirmed|wants|wanted)';
const SAID = '(?:wrote|said|asked|noted|added|changed|reported|suggested|agreed|signed)';
// After a said-verb the date must read as when it was said: not inside a number, not after a
// preposition that makes it the thing's own time ("added for 2026-01-01", "changed since 10.17"),
// and ending the clause (end of line, a bracket, a colon, a comma, a full stop, a dash).
const SAID_DATE = String.raw`(?<![\d./-])(?<!\b(?:for|in|of|since|before|after|until|till|at|from|to|by|per)\s)(?:${DATE})` +
  String.raw`(?=\s*(?:$|[)\]:;,]|[.!?](?:\s|$)|[-–—]\s))`;
const NOT_QUOTED_BEFORE = String.raw`(?<![“"'«\`\w/-])`;
const NOT_QUOTED_AFTER = String.raw`(?![”"'»\`\w.-])`;

/** Capitalised words that are not people: products, platforms, sentence openers. */
export const NOT_NAMES = new Set(['Node', 'Claude', 'Codex', 'Cursor', 'Code', 'Desktop', 'Version', 'Windows', 'Linux',
  'Chrome', 'Atlas', 'Wybe', 'Anthropic', 'OpenAI', 'Since', 'Until', 'From', 'After', 'Before', 'Then', 'Today', 'See',
  'Updated', 'Verified', 'Released', 'Fixed', 'Added', 'Changed', 'Removed', 'Last', 'Next', 'The', 'This', 'That',
  'Ubuntu', 'Debian', 'Fedora', 'Alpine', 'Mint', 'Rocky', 'Postgres', 'Redis', 'Nginx', 'Docker', 'Python', 'Ruby',
  'Java', 'Kotlin', 'Swift', 'Rust', 'Go', 'Bun', 'Deno', 'Electron', 'Android', 'Xcode', 'Firefox', 'Safari', 'Edge',
  'Git', 'Kernel', 'Release', 'Build', 'Patch']);

/** [kind, pattern, does group 1 hold a name to check against NOT_NAMES?] */
export const PATTERNS = [
  ['ruling id', new RegExp(String.raw`${NOT_QUOTED_BEFORE}R[0-9]{2,3}${NOT_QUOTED_AFTER}`), false],
  ['ruling id', /\bR\d{1,3}-F\d{1,3}\b/, false],
  ['ruling id', new RegExp(String.raw`${NOT_QUOTED_BEFORE}I-[0-9]{1,4}${NOT_QUOTED_AFTER}`), false],
  ['ruling id', /\bN-R[0-9]+\b/, false],
  ['ruling id', /\bD-[a-z][a-z0-9]*-(?:\d+|link)\b/, false],
  ['citation', /\brulings?\s+(?:R\d|I-\d|N-R\d|file|index|list|log)\b|\b(?:orchestrator|oracle|coordinator)\s+rulings?\b/i, false],
  ['citation', /\bQA\s*(?:#\s*\d+|round\s*\d+|r\d+)\b/i, false],
  ['citation', /\b[Pp]lan\s+(?:[Tt]rack\s+)?[A-Z]\d+(?:\.\d+)*\b/, false],
  ['attribution', new RegExp(String.raw`${NAME}[ ,:(]{1,3}(?:${DATE})`, 'u'), true],
  ['attribution', new RegExp(String.raw`${NAME}\s+${SAID}\b[^\n]{0,40}?${SAID_DATE}`, 'u'), true],
  ['attribution', new RegExp(String.raw`${NAME}['’]s\s+${DECISION_WORD}\b`, 'u'), true],
  ['attribution', new RegExp(String.raw`${NAME}\s+${VERB}\b`, 'u'), true],
  ['attribution', new RegExp(String.raw`${NAME}\b[^\n]{0,24}\bverbatim\b`, 'u'), true],
];

const SKIP_EXACT = new Set(['scripts/check-no-rulings.mjs', 'test/check-no-rulings.test.js']);
const SKIP = [/^test\/fixtures\//, /(^|\/)node_modules\//, /package-lock\.json$/,
  /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|tgz|zst|svg)$/i];

export function isChecked(file) {
  return !SKIP_EXACT.has(file) && !SKIP.some((re) => re.test(file));
}

/** The hits on one line: [{ kind, match }]. */
export function scanLine(line) {
  const hits = [];
  for (const [kind, re, named] of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of line.matchAll(g)) {
      if (named && NOT_NAMES.has(m[1])) continue;
      hits.push({ kind, match: m[0] });
      break;
    }
  }
  return hits;
}

function trackedLines() {
  const out = [];
  for (const file of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)) {
    let t; try { t = readFileSync(file, 'utf8'); } catch { continue; }
    if (t.includes('\0')) continue;
    t.split('\n').forEach((text, i) => out.push({ file, nr: i + 1, text }));
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  let lines;
  if (all) lines = trackedLines();
  else {
    const { base, reason } = findBase(baseArg(argv));
    if (!base) { console.error(`check-no-rulings: no base to compare with: ${reason}; run with --base <ref> or --all`); process.exitCode = 1; return; }
    lines = addedLines(base);
  }
  let n = 0;
  for (const { file, nr, text } of lines) {
    if (!isChecked(file) || text.length > 2000) continue;
    for (const h of scanLine(text)) { console.error(`${file}:${nr}: ${h.kind} «${h.match}»`); n++; }
  }
  if (!n) { console.log(`check-no-rulings: ${lines.length} line(s), clean`); return; }
  console.error(`\ncheck-no-rulings: ${n} hit(s). Say the reason in plain words and drop the id, the citation or the` +
    '\nname with a date. Who decided what lives in git history and pull requests, not in the code.');
  if (all) { console.error('check-no-rulings: --all reports and does not fail.'); return; }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
