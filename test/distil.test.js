import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../lib/home.js';
import { ALLOWED_TOOLS, DISTIL_ENV, importRequestOf, loadState, maybeRun, noteSession, planRun, runArgs, startRun } from '../lib/distil.js';

const home = () => paths(mkdtempSync(join(tmpdir(), 'wybe-connect-distil-')));
const T0 = Date.parse('2026-10-21T12:00:00Z');
const H = 60 * 60 * 1000;
const IMPORT_AT = '2026-10-21T11:59:00.000Z';

/** Records spawns; never starts a process. */
function recorder() {
  const spawns = [];
  const spawnImpl = (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { pid: 4242, on() {}, unref() {} }; };
  return { spawns, spawnImpl };
}

test('noteSession: one entry per transcript, newest last, capped', () => {
  const p = home();
  noteSession(p, { transcriptPath: '/t/a.jsonl', now: T0 });
  noteSession(p, { transcriptPath: '/t/b.jsonl', now: T0 + 1 });
  noteSession(p, { transcriptPath: '/t/a.jsonl', now: T0 + 2 });
  assert.deepEqual(loadState(p).pending.map((x) => x.transcriptPath), ['/t/b.jsonl', '/t/a.jsonl']);
  noteSession(p, { transcriptPath: null, now: T0 + 3 });
  assert.equal(loadState(p).pending.length, 2, 'no path, nothing noted');
});

test('planRun: an import the node asked for wins; a handled one is not repeated; ongoing waits for the interval', () => {
  const dead = () => false;
  const empty = { importHandled: null, lastRunAt: null, running: null, pending: [] };
  assert.equal(planRun(empty, { now: T0, isAlive: dead }), null, 'nothing noted, nothing asked: no run');
  assert.deepEqual(planRun(empty, { now: T0, importRequestedAt: IMPORT_AT, isAlive: dead }), { mode: 'import', importOf: IMPORT_AT });
  assert.equal(planRun({ ...empty, importHandled: IMPORT_AT }, { now: T0, importRequestedAt: IMPORT_AT, isAlive: dead }), null, 'the same request is handled once');
  const noted = { ...empty, pending: [{ transcriptPath: '/t/a.jsonl' }] };
  assert.deepEqual(planRun(noted, { now: T0, isAlive: dead }), { mode: 'ongoing', transcripts: ['/t/a.jsonl'] }, 'first run ever: due');
  assert.equal(planRun({ ...noted, lastRunAt: new Date(T0 - 5 * H).toISOString() }, { now: T0, isAlive: dead }), null, '5 h after the last run: not yet');
  assert.ok(planRun({ ...noted, lastRunAt: new Date(T0 - 6 * H).toISOString() }, { now: T0, isAlive: dead }), '6 h: due');
});

test('planRun: a live run blocks both triggers; a dead or stale one does not', () => {
  const running = { importHandled: null, lastRunAt: new Date(T0 - 7 * H).toISOString(), running: { pid: 1, startedAt: new Date(T0 - 10 * 60_000).toISOString() }, pending: [{ transcriptPath: '/t/a.jsonl' }] };
  assert.equal(planRun(running, { now: T0, importRequestedAt: IMPORT_AT, isAlive: () => true }), null);
  assert.ok(planRun(running, { now: T0, importRequestedAt: IMPORT_AT, isAlive: () => false }), 'the run is gone');
  const stale = { ...running, running: { pid: 1, startedAt: new Date(T0 - 3 * H).toISOString() } };
  assert.ok(planRun(stale, { now: T0, importRequestedAt: IMPORT_AT, isAlive: () => true }), 'older than 2 h no longer blocks');
});

test('startRun: detached headless claude -p with read-only tools plus the two Wybe tools, marked as a distil run, logged under state/', () => {
  const p = home();
  const r = recorder();
  noteSession(p, { transcriptPath: '/t/a.jsonl', now: T0 });
  startRun({ mode: 'ongoing', transcripts: ['/t/a.jsonl'] }, { paths: p, now: T0, spawnImpl: r.spawnImpl, claudeBin: 'claude', cwd: '/home/x' });
  assert.equal(r.spawns.length, 1);
  const [s] = r.spawns;
  assert.equal(s.cmd, 'claude');
  assert.equal(s.args[0], '-p');
  assert.deepEqual(s.args.slice(2, 6), ['--allowedTools', ALLOWED_TOOLS.join(','), '--output-format', 'text']);
  assert.ok(!ALLOWED_TOOLS.some((t) => /Bash|Write|Edit|WebFetch/.test(t)), 'no tool that writes or reaches the network');
  assert.equal(s.opts.detached, true);
  assert.equal(s.opts.env[DISTIL_ENV], '1');
  assert.equal(s.opts.cwd, '/home/x');
  const state = loadState(p);
  assert.deepEqual(state.running, { pid: 4242, startedAt: new Date(T0).toISOString(), mode: 'ongoing', log: state.running.log });
  assert.ok(state.running.log.startsWith(p.state) && existsSync(state.running.log));
  assert.deepEqual(state.pending, []);
  assert.equal(state.lastRunAt, new Date(T0).toISOString());
});

test('import: the prompt names the mode and import_of exactly; the request is marked handled', () => {
  const p = home();
  const r = recorder();
  const plan = maybeRun({ paths: p, importRequestedAt: IMPORT_AT, env: {}, now: T0, spawnImpl: r.spawnImpl, isAlive: () => false });
  assert.deepEqual(plan, { mode: 'import', importOf: IMPORT_AT });
  assert.match(r.spawns[0].args[1], /Mode: import/);
  assert.match(r.spawns[0].args[1], new RegExp(`import_of: ${IMPORT_AT.replace(/\./g, '\\.')}`));
  assert.equal(loadState(p).importHandled, IMPORT_AT);
  assert.equal(maybeRun({ paths: p, importRequestedAt: IMPORT_AT, env: {}, now: T0 + 3 * H, spawnImpl: r.spawnImpl, isAlive: () => false }), null, 'not twice');
  assert.equal(r.spawns.length, 1);
});

test('maybeRun never starts a run from inside a run', () => {
  const p = home();
  const r = recorder();
  assert.equal(maybeRun({ paths: p, importRequestedAt: IMPORT_AT, env: { [DISTIL_ENV]: '1' }, now: T0, spawnImpl: r.spawnImpl }), null);
  assert.equal(r.spawns.length, 0);
  assert.equal(existsSync(join(p.state, 'distil.json')), false);
});

test('a .js/.mjs claude bin runs under this Node (wrappers and the tests\' recorder)', () => {
  const p = home();
  const r = recorder();
  startRun({ mode: 'import', importOf: IMPORT_AT }, { paths: p, now: T0, spawnImpl: r.spawnImpl, claudeBin: '/x/fake-claude.mjs' });
  assert.equal(r.spawns[0].cmd, process.execPath);
  assert.equal(r.spawns[0].args[0], '/x/fake-claude.mjs');
  assert.equal(r.spawns[0].args[1], '-p');
});

test('runArgs adds --model only when WYBE_CONNECT_DISTIL_MODEL is set', () => {
  assert.ok(!runArgs({ mode: 'import', importOf: IMPORT_AT }, { model: undefined }).includes('--model'));
  assert.deepEqual(runArgs({ mode: 'import', importOf: IMPORT_AT }, { model: 'sonnet' }).slice(-2), ['--model', 'sonnet']);
});

test('importRequestOf reads structuredContent or the JSON text, else null', () => {
  assert.equal(importRequestOf({ structuredContent: { import_request: { requested_at: IMPORT_AT } } }), IMPORT_AT);
  assert.equal(importRequestOf({ content: [{ type: 'text', text: JSON.stringify({ ok: true, open_questions: [], import_request: { requested_at: IMPORT_AT } }) }] }), IMPORT_AT);
  assert.equal(importRequestOf({ content: [{ type: 'text', text: '{"ok":true}' }] }), null);
  assert.equal(importRequestOf({ content: [{ type: 'text', text: 'prose' }] }), null);
  assert.equal(importRequestOf(null), null);
  assert.ok(readFileSync(new URL('../lib/distil.js', import.meta.url), 'utf8').includes('WYBE_CONNECT_DISTIL'));
});
