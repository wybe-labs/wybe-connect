import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLine, findBase, addedLines } from '../scripts/leak-scan.mjs';

// The addresses are put together at run time, so this file never carries one the scan would flag.
const at = (local, domain) => `${local}@${domain}`;
const kinds = (line) => scanLine(line);

test('an e-mail address at a mail provider in an added line fails', () => {
  assert.deepEqual(kinds(`const owner = '${at('kari.nordmann', 'gmail.com')}';`), ['email']);
});

test('an e-mail address at example.invalid passes', () => {
  assert.deepEqual(kinds(`const owner = '${at('kari.nordmann', 'example.invalid')}';`), []);
});

test('reserved and own domains pass: example.*, *.test, *.invalid, localhost, wybe.me', () => {
  for (const domain of ['example.com', 'example.org', 'db.example.internal', 'gitlab.example.test', 'node.test',
    'localhost', 'wybe.me', 'dittfirma.wybe.me', 'users.noreply.github.com']) {
    assert.deepEqual(kinds(at('someone', domain)), [], domain);
  }
});

test('an SSH remote (git@host) is not a person', () => {
  assert.deepEqual(kinds(`git clone ${at('git', 'github.com')}:wybe-labs/wybe-connect.git`), []);
});

test('URL userinfo and an escaped SSH remote are not addresses', () => {
  assert.deepEqual(kinds(`https://user:${at('PLANTED-PW', 'github.com')}/x.git`), []);
  assert.deepEqual(kinds(`"url = ${at('\\tgit','github.com')}:x/y.git"`), []);
});

test('a scoped package name and a plugin@marketplace id are not e-mail addresses', () => {
  assert.deepEqual(kinds('"name": "@wybe-labs/wybe-connect"'), []);
  assert.deepEqual(kinds('/plugin install wybe-connect@wybe-connect'), []);
});

test('phone numbers fail, made-up ones pass', () => {
  assert.deepEqual(kinds('call +47 412 34 567 after nine'), ['phone']);   // leak-scan: ignore
  assert.deepEqual(kinds('ring 912 34 567'), ['phone']);   // leak-scan: ignore
  assert.deepEqual(kinds('call +4412345678901 at once'), ['phone']);   // leak-scan: ignore
  assert.deepEqual(kinds('placeholder +47 99999999'), []);
  assert.deepEqual(kinds('placeholder 12345678'), []);
});

test('versions, ports and timestamps are not phone numbers', () => {
  assert.deepEqual(kinds('Node 20.11 or newer, Claude Code 2.1.292'), []);
  assert.deepEqual(kinds('https://node.example.invalid:8447/mcp at 2026-01-02T03:04:05.678Z'), []);
});

test('a line can opt out with a marker, for a value that is made up on purpose', () => {
  assert.deepEqual(kinds(`'${at('kari.nordmann', 'gmail.com')}' // leak-scan: ignore`), []);
});

test('the base: a pull request diffs against its target branch, a push against the commit before it', () => {
  const mergeBase = (ref) => { if (ref === 'origin/main') return 'aaa'; if (ref === 'HEAD^1') return 'bbb'; throw new Error('no ref'); };
  assert.deepEqual(findBase(null, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' }, mergeBase), { base: 'aaa' });
  assert.deepEqual(findBase(null, { GITHUB_EVENT_NAME: 'push' }, mergeBase), { base: 'bbb' });
  assert.deepEqual(findBase('v1', { GITHUB_EVENT_NAME: 'push' }, mergeBase), { base: 'v1' });
  const missing = findBase(null, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'release' }, mergeBase);
  assert.equal(missing.base, null, 'a missing target branch is an error, never a smaller scan');
  assert.match(missing.reason, /origin\/release/);
});

test('only lines a commit added are read, with their file and line number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-leak-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', at('ci', 'example.invalid'));
    git('config', 'user.name', 'ci');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'a.txt'), `kept\n${at('old', 'gmail.com')}\n`);
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    writeFileSync(join(dir, 'a.txt'), `kept\n${at('old', 'gmail.com')}\nnew line\n`);
    git('commit', '-q', '-am', 'two');
    const lines = addedLines('HEAD~1', dir);
    assert.deepEqual(lines, [{ file: 'a.txt', nr: 3, text: 'new line' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
