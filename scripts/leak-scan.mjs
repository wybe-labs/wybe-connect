#!/usr/bin/env node
/**
 * Leak scan: e-mail addresses and phone numbers in the lines a change adds. CI's "checks" job.
 *
 * Why: personal data reaches a public repository as a test fixture that is not made up, an
 * example, or a log pasted into a comment. This repository is public, so the scan says no before
 * anyone else can clone it.
 *
 * What it looks for, in added lines (default) or in the whole tree (--all):
 *   email  an address outside the reserved and own domains in ALLOWED_DOMAINS (example.*, *.test,
 *          *.invalid, localhost, wybe.me); `git@host` is an SSH remote, not a person
 *   phone  Norwegian mobile numbers (8 digits starting with 4 or 9: bare, in groups, or after +47)
 *          and international +<10-15 digits>, except obviously made-up ones (one digit repeated,
 *          12345678 runs)
 *
 * It prints file:line and the kind of hit, never the value. The last line is LEAK_SCAN_OK or
 * LEAK_SCAN_FAIL. A line that carries a made-up value on purpose can opt out with the comment
 * `leak-scan: ignore`.
 *
 *   node scripts/leak-scan.mjs                 # added since the base (see findBase)
 *   node scripts/leak-scan.mjs --base <ref>    # added since <ref>
 *   node scripts/leak-scan.mjs --all           # the whole tree (an audit)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EMAIL = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const PHONE = [
  /(?<![\w+])\+47[\s.-]?(?:\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}|\d{3}[\s.-]?\d{2}[\s.-]?\d{3})(?!\d)/g,
  /(?<![\w+\d.-])[49]\d{2}[\s.]\d{2}[\s.]\d{3}(?![\d.])/g,
  /(?<![\w+\d])[49]\d[\s.]\d{2}[\s.]\d{2}[\s.]\d{2}(?![\d.])/g,
  /(?<![\w+.,-])[49]\d{7}(?![\w.,-])/g,
  /(?<![\w\d])\+(?!47)[1-9]\d{9,14}(?!\d)/g,
];
const SKIP_FILES = [/(^|\/)node_modules\//, /package-lock\.json$/,
  /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|mp4|webm|mov|zip|gz|tgz|zst|svg)$/i];

/** Domains whose addresses are not personal data. `*.x` is x and everything under it. */
export const ALLOWED_DOMAINS = ['*.test', '*.invalid', '*.local', '*.localhost', 'localhost',
  'wybe.me', '*.wybe.me', 'users.noreply.github.com'];

function domainAllowed(domain) {
  const d = domain.toLowerCase();
  if (d.split('.').includes('example')) return true;   // example.com, db.example.internal, *.example
  return ALLOWED_DOMAINS.some((a) => (a.startsWith('*.') ? d.endsWith(a.slice(1)) || d === a.slice(2) : d === a));
}

/**
 * Whether a match is an address at all. Not: `git@host` (an SSH remote), `//user:secret@host` (URL
 * userinfo; the secret is the redactor's and the secrets scan's business), and `\tgit@host`, where
 * the `t` belongs to an escape in a JSON string.
 */
function isAddress(line, m) {
  const before = line.slice(0, m.index);
  if (/\/\/[^\s/@]*:$/.test(before)) return false;
  const local = (before.endsWith('\\') &&/^[ntr]/.test(m[1]) ? m[1].slice(1) : m[1]).toLowerCase();
  return local !== 'git';
}

function madeUp(number) {
  const digits = number.replace(/\D/g, '').replace(/^47(?=\d{8}$)/, '');
  if (/^(\d)\1+$/.test(digits)) return true;                                    // 99999999
  if ('0123456789012345'.includes(digits) || '9876543210987654'.includes(digits)) return true;
  if (/^(\d)\1{3,}/.test(digits.slice(1)) || /(\d)\1{5,}/.test(digits)) return true;   // 40000000, 12000000
  return false;
}

/** The kinds of personal data on one line: 'email' and 'phone', one entry per hit. */
export function scanLine(line) {
  if (/leak-scan:\s*ignore/.test(line)) return [];
  if (/\sd="[Mm][\d\s.,-]/.test(line) || /viewBox="/.test(line)) return [];   // SVG paths are numbers, not phones
  const hits = [];
  for (const m of line.matchAll(EMAIL)) if (isAddress(line, m) && !domainAllowed(m[2])) hits.push('email');
  const taken = [];   // one number can match two patterns (+47 and 8 digits): count it once
  for (const re of PHONE) for (const m of line.matchAll(re)) {
    const a = m.index, b = m.index + m[0].length;
    if (taken.some(([x, y]) => a < y && x < b)) continue;
    taken.push([a, b]);
    if (!madeUp(m[0])) hits.push('phone');
  }
  return hits;
}

/**
 * The lines added since `base`: [{ file, nr, text }]. A file's name is read only from its header
 * (between `diff --git` and the first @@), never from a hunk: an added line that itself starts
 * with "++" shows as "+++ ..." in the diff and is content.
 */
export function addedLines(base, cwd = process.cwd()) {
  const diff = execFileSync('git', ['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=AMR', base, '--'],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = [];
  let file = null; let nr = 0; let inHunk = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { nr = Number(h[1]); inHunk = true; continue; }
    if (!inHunk) { if (l.startsWith('+++ ')) file = l.slice(4).replace(/^b\//, ''); continue; }
    if (file && l.startsWith('+')) { out.push({ file, nr, text: l.slice(1).replace(/\r$/, '') }); nr++; }
  }
  return out;
}

function allLines(cwd = process.cwd()) {
  const out = [];
  for (const file of execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean)) {
    let t; try { t = readFileSync(file, 'utf8'); } catch { continue; }
    if (t.includes('\0')) continue;
    t.split('\n').forEach((text, i) => out.push({ file, nr: i + 1, text }));
  }
  return out;
}

const gitMergeBase = (ref) => execFileSync('git', ['merge-base', 'HEAD', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * What "added" is measured against. One answer per event, and never a quiet fallback that reads less:
 *   pull_request  the merge base with origin/<target branch> (the checkout fetches full history).
 *                 When it is missing that is an error: HEAD~1 would see only the last commit.
 *   push          PUSH_BEFORE (the workflow passes github.event.before), the branch as it was
 *                 before the push, so a push of several commits is read whole. For a new branch
 *                 (all zeros) or a commit no longer in the checkout: HEAD^1.
 *   local         origin/main, else HEAD~1.
 * `{ base: null, reason }` means "unknown"; main() says so and fails instead of reading everything.
 */
export function findBase(arg, env = process.env, mergeBase = gitMergeBase) {
  if (arg) return { base: arg };
  const tryRef = (ref) => { try { return mergeBase(ref); } catch { return null; } };
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    const target = env.GITHUB_BASE_REF;
    const base = target ? tryRef(`origin/${target}`) : null;
    return base ? { base } : { base: null, reason: `the target branch origin/${target ?? '?'} is not in the checkout (fetch-depth: 0?)` };
  }
  if (env.GITHUB_EVENT_NAME === 'push') {
    const before = env.PUSH_BEFORE && !/^0+$/.test(env.PUSH_BEFORE) ? tryRef(env.PUSH_BEFORE) : null;
    const base = before ?? tryRef('HEAD^1');
    return base ? { base } : { base: null, reason: 'a push without a parent (HEAD^1 is not in the checkout)' };
  }
  const base = tryRef('origin/main') ?? tryRef('HEAD~1');
  return base ? { base } : { base: null, reason: 'neither origin/main nor HEAD~1 exists' };
}

/** The --base argument, or null. */
export function baseArg(argv) {
  const i = argv.indexOf('--base');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  let lines;
  if (argv.includes('--all')) lines = allLines();
  else {
    const { base, reason } = findBase(baseArg(argv));
    if (!base) { console.log(`no base to compare with: ${reason}\nrun with --base <ref> or --all\nLEAK_SCAN_FAIL`); process.exitCode = 1; return; }
    console.log(`base ${base.slice(0, 12)}`);
    lines = addedLines(base);
  }
  let n = 0;
  for (const { file, nr, text } of lines) {
    if (SKIP_FILES.some((re) => re.test(file)) || text.length > 2000) continue;
    for (const kind of scanLine(text)) { console.log(`${file}:${nr}  ${kind}`); n++; }
  }
  console.log(n ? `${n} possible personal data\nLEAK_SCAN_FAIL` : `${lines.length} lines, nothing found\nLEAK_SCAN_OK`);
  process.exitCode = n ? 1 : 0;
}

// pathToFileURL, not `file://${argv[1]}`: on Windows the path is C:\... and the URL file:///C:/...
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
