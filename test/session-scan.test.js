// Every session on disk reaches the colleague, not only the ones the plugin's hooks ran in: the
// scan (lib/session-scan.js) through the bridge's poller (lib/bridge.js), against a fake node on
// 127.0.0.1. Open and closed, open first, in bounded batches, idempotent, with can_take_tasks, a
// summary only on sessions:full, and never another account's sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { connectionPaths, resolveSession } from '../lib/connections.js';
import { saveCredentials } from '../lib/home.js';
import { touchSession, claimPoller, runPoller, scanSessions, reportSession } from '../lib/bridge.js';
import { scanTick, saveSummary, SCAN_BATCH, SCAN_EVERY_MS, REFRESH_OPEN_MS } from '../lib/session-scan.js';
import { startFakeNode, grantFor, TOKEN } from './fixtures/fake-node.mjs';

const FIX = join(import.meta.dirname, 'fixtures');
const DAY = 24 * 60 * 60 * 1000;
const PLANTED = ['sk-ant-api03-', 'Pl4ntedScanSecret0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ-AAAAAAAA'].join('');

function home(node, { scopes = ['remember', 'sessions:light'], account = 'eier@example.invalid', second = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-scan-'));
  const p = connectionPaths(root, 'node-a');
  saveCredentials(grantFor(node, { scopes, ...(second ? { harnessAccount: account } : {}) }), p);
  let q = null;
  if (second) {
    q = connectionPaths(root, 'node-b');
    saveCredentials(grantFor(node, { scopes, harnessAccount: second, grantId: 'g2' }), q);
  }
  const claude = mkdtempSync(join(tmpdir(), 'wybe-connect-scan-claude-'));
  writeFileSync(join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: account } }));
  const codex = mkdtempSync(join(tmpdir(), 'wybe-connect-scan-codex-'));
  return { root, p, q, claude, codex, env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } };
}

/** A Claude Code transcript under <claude>/projects/<dir>/<id>.jsonl, last written `ageMs` ago. */
function transcript(claude, { id = randomUUID(), project = 'demo-app', prompt = 'Fix the flaky login test', ageMs = 0, first = null } = {}) {
  const dir = join(claude, 'projects', `-work-${project}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const at = new Date(Date.now() - ageMs - 60_000).toISOString();
  const cwd = `/home/eier/work/${project}`;
  const lines = [
    { type: 'user', uuid: 'u-1', timestamp: at, cwd, sessionId: id, isSidechain: false, message: { role: 'user', content: first ?? prompt } },
    { type: 'assistant', uuid: 'a-1', timestamp: at, cwd, sessionId: id, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'PLANTED-ASSISTANT-SENTENCE about the work.' }] } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
  return { id, path };
}

const sent = (node) => node.tool('sessions_report').flatMap((c) => c.args.sessions);
const byId = (node) => new Map(sent(node).map((s) => [s.id, s]));
const scan = (h, extra = {}) => scanSessions(h.p, { harness: 'claude-code', env: h.env, ...extra });

test('every Claude Code session on disk is reported, hooked or not, open or closed, with can_take_tasks only where the plugin polls', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const hooked = transcript(h.claude, { project: 'atlas-demo', prompt: 'Add a retry to the ingest queue' });
    const before = transcript(h.claude, { project: 'crm-demo', prompt: 'Rename the pipeline stages', ageMs: 3 * 60 * 60 * 1000 });
    const old = transcript(h.claude, { project: 'crm-demo', prompt: 'Write the import script', ageMs: 90 * DAY });
    // the plugin's hooks ran in one session: it has a record and a poller
    touchSession(h.p, hooked.id, { harness: 'claude-code', cwd: '/home/eier/work/atlas-demo', transcriptPath: hooked.path });
    claimPoller(h.p, hooked.id);
    // one was opened before the plugin was installed: Claude Code's own mark of a running session says it is open
    mkdirSync(join(h.claude, 'sessions'), { recursive: true });
    writeFileSync(join(h.claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: before.id, cwd: '/home/eier/work/crm-demo', startedAt: Date.now() - DAY }));

    const r = await scan(h);
    assert.equal(r.ran, true);
    const got = byId(node);
    assert.deepEqual([...got.keys()].sort(), [hooked.id, before.id, old.id].sort());
    assert.deepEqual([got.get(hooked.id).state, got.get(hooked.id).can_take_tasks], ['open', true]);
    assert.deepEqual([got.get(before.id).state, got.get(before.id).can_take_tasks], ['open', false]);
    assert.deepEqual([got.get(old.id).state, got.get(old.id).can_take_tasks], ['closed', false]);
    assert.equal(got.get(old.id).project, 'crm-demo');
    assert.equal(got.get(old.id).title, 'Write the import script');
    assert.equal(got.get(old.id).account, 'eier@example.invalid');
    assert.equal(got.get(old.id).harness, 'claude-code');
    assert.ok(Date.parse(got.get(old.id).last_active_at) < Date.now() - 80 * DAY, 'last active is when the transcript was last written');
    assert.ok(Date.parse(got.get(old.id).started_at) <= Date.parse(got.get(old.id).last_active_at));
    // open first
    const order = sent(node).map((s) => s.state);
    assert.deepEqual(order, [...order].sort((a, b) => (a === b ? 0 : a === 'open' ? -1 : 1)));
    const body = node.calls.map((c) => c.body).join('\n');
    for (const s of ['PLANTED-ASSISTANT-SENTENCE', '/home/eier/work', h.claude, TOKEN]) assert.ok(!body.includes(s), `left the machine: ${s.slice(0, 20)}`);
  } finally {
    await node.close();
  }
});

test('in batches of at most SCAN_BATCH, open first; the same sessions unchanged are not sent again', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const n = SCAN_BATCH + 7;
    for (let i = 0; i < n; i++) transcript(h.claude, { project: `p${i % 3}`, prompt: `Task number ${i}`, ageMs: (i + 1) * DAY });
    const recent = transcript(h.claude, { project: 'p-new', prompt: 'Still typing here' });
    const first = await scan(h);
    assert.equal(node.tool('sessions_report').length, 1);
    assert.equal(node.tool('sessions_report')[0].args.sessions.length, SCAN_BATCH);
    assert.equal(node.tool('sessions_report')[0].args.sessions[0].id, recent.id, 'the open one first');
    assert.equal(first.backlog, n + 1 - SCAN_BATCH);
    const second = await scan(h);
    assert.equal(second.reported, n + 1 - SCAN_BATCH);
    assert.equal(new Set(sent(node).map((s) => s.id)).size, n + 1, 'every session once');
    // nothing changed: the next due tick sends nothing
    const third = await scan(h, { now: () => Date.now() + 6 * 60_000 });
    assert.equal(third.ran, true);
    assert.equal(third.reported, 0);
    assert.equal(node.tool('sessions_report').length, 2);
    // a session that stopped being written is closed now: only that change is sent
    const fourth = await scan(h, { now: () => Date.now() + 20 * 60_000 });
    assert.equal(fourth.reported, 1);
    assert.deepEqual(node.tool('sessions_report').at(-1).args.sessions.map((s) => [s.id, s.state]), [[recent.id, 'closed']]);
  } finally {
    await node.close();
  }
});

test('the poller of one hooked session reports the sessions on disk too', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const hooked = transcript(h.claude, { project: 'atlas-demo' });
    const other = transcript(h.claude, { project: 'crm-demo', prompt: 'Draft the release notes', ageMs: 5 * DAY });
    touchSession(h.p, hooked.id, { harness: 'claude-code', cwd: '/home/eier/work/atlas-demo', transcriptPath: hooked.path });
    const stop = setTimeout(() => touchSession(h.p, hooked.id, { closed: true }), 400);
    const out = await runPoller({ paths: h.p, sessionId: hooked.id, harness: 'claude-code', env: h.env, intervalMs: 50, onTasks: async () => 'stop' });
    clearTimeout(stop);
    assert.equal(out.exit, 'closed');
    assert.ok(byId(node).has(other.id), 'a session the plugin never ran in is reported');
    assert.equal(byId(node).get(other.id).state, 'closed');
  } finally {
    await node.close();
  }
});

test('never another account\'s sessions: an unpinned session goes only to the harness account\'s connection, a pinned one only to its pin', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node, { account: 'eier@example.invalid', second: 'annen@example.invalid' });
    const mine = transcript(h.claude, { project: 'atlas-demo', ageMs: DAY });
    const moved = transcript(h.claude, { project: 'crm-demo', ageMs: DAY });
    // this one session was pinned to the other connection by its own hook
    resolveSession(h.root, { sessionId: moved.id, env: { WYBE_CONNECT_NODE: 'node-b' }, transcriptPath: moved.path });

    await scanSessions(h.p, { harness: 'claude-code', env: h.env });
    assert.deepEqual(sent(node).map((s) => s.id), [mine.id]);
    node.calls.length = 0;
    await scanSessions(h.q, { harness: 'claude-code', env: h.env });
    assert.deepEqual(sent(node).map((s) => s.id), [moved.id], 'the other connection gets only its pinned session');
    // the scanning process's own WYBE_CONNECT_NODE says nothing about another session
    node.calls.length = 0;
    const h2 = { ...h, env: { ...h.env, WYBE_CONNECT_NODE: 'node-b' } };
    await scanSessions(h2.q, { harness: 'claude-code', env: h2.env, now: () => Date.now() + 10 * 60_000 });
    assert.ok(!sent(node).some((s) => s.id === mine.id));
  } finally {
    await node.close();
  }
});

test('a summary is reported only with sessions:full, redacted; never transcript text', async () => {
  const node = await startFakeNode();
  try {
    const full = home(node, { scopes: ['remember', 'sessions:full'] });
    const t = transcript(full.claude, { project: 'atlas-demo', ageMs: DAY });
    assert.ok(saveSummary(full.p, t.id, `Adds a retry with backoff to the ingest queue; key ${PLANTED} was used.`));
    await scan(full);
    const s = byId(node).get(t.id);
    assert.match(s.summary, /^Adds a retry with backoff/);
    assert.ok(!s.summary.includes(PLANTED));
    assert.ok(!JSON.stringify(s).includes('PLANTED-ASSISTANT-SENTENCE'));
    // the hooked session's own report carries it too
    touchSession(full.p, t.id, { harness: 'claude-code', cwd: '/w/atlas-demo', transcriptPath: t.path });
    await reportSession(full.p, t.id, { env: full.env });
    assert.match(node.tool('sessions_report').at(-1).args.sessions[0].summary, /^Adds a retry/);
    assert.equal(node.tool('sessions_report').at(-1).args.sessions[0].can_take_tasks, true);

    node.calls.length = 0;
    const light = home(node, { scopes: ['remember', 'sessions:light'] });
    const u = transcript(light.claude, { project: 'atlas-demo', ageMs: DAY });
    saveSummary(light.p, u.id, 'Adds a retry with backoff to the ingest queue.');
    await scan(light);
    assert.equal(byId(node).get(u.id).summary, undefined);
    // without a sessions scope nothing is scanned or sent
    node.calls.length = 0;
    const none = home(node, { scopes: ['remember'] });
    transcript(none.claude, {});
    assert.equal((await scan(none)).ran, false);
    assert.equal(node.calls.length, 0);
  } finally {
    await node.close();
  }
});

test('the distil runs\' own sessions and subagent threads are left out', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const person = transcript(h.claude, { project: 'atlas-demo', ageMs: DAY });
    transcript(h.claude, { project: 'atlas-demo', ageMs: DAY, first: 'wybe-connect distil run (started in the background by the wybe-connect plugin, not by a person).' });
    const sub = join(h.claude, 'projects', '-work-atlas-demo', person.id, 'subagents');
    mkdirSync(sub, { recursive: true });
    copyFileSync(person.path, join(sub, 'agent-a1b2c3.jsonl'));
    await scan(h);
    assert.deepEqual(sent(node).map((s) => s.id), [person.id]);
  } finally {
    await node.close();
  }
});

test('Codex: every rollout of the person\'s, archived ones closed; subagent threads left out', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const day = join(h.codex, 'sessions', '2026', '09', '22');
    mkdirSync(day, { recursive: true });
    const id = '0190c0de-0000-7000-8000-00000000c0de';
    copyFileSync(join(FIX, 'codex-rollout.jsonl'), join(day, `rollout-2026-09-22T09-00-00-${id}.jsonl`));
    const subId = '0190c0de-0000-7000-8000-0000000000aa';
    copyFileSync(join(FIX, 'codex-rollout-subagent.jsonl'), join(day, `rollout-2026-09-22T09-30-00-${subId}.jsonl`));
    const arch = join(h.codex, 'archived_sessions');
    mkdirSync(arch, { recursive: true });
    const archId = '0190c0de-0000-7000-8000-0000000000bb';
    writeFileSync(join(arch, `rollout-2026-08-01T09-00-00-${archId}.jsonl`), readFileSync(join(FIX, 'codex-rollout.jsonl'), 'utf8').replaceAll(id, archId));
    const old = new Date(Date.now() - 30 * DAY);
    utimesSync(join(day, `rollout-2026-09-22T09-00-00-${id}.jsonl`), old, old);
    await scanSessions(h.p, { harness: 'codex', env: h.env });
    const got = byId(node);
    assert.deepEqual([...got.keys()].sort(), [id, archId].sort());
    assert.equal(got.get(id).harness, 'codex');
    assert.equal(got.get(id).project, 'atlas-demo');
    assert.equal(got.get(archId).state, 'closed');
    assert.ok(!node.calls.map((c) => c.body).join('\n').includes('PLANTED-REMOTE-PW'));
  } finally {
    await node.close();
  }
});

test('an open session is sent again every REFRESH_OPEN_MS while unchanged, so the node keeps it open; a closed one is not', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const open = transcript(h.claude, { project: 'atlas-demo', ageMs: 2 * DAY });
    const closed = transcript(h.claude, { project: 'crm-demo', ageMs: 2 * DAY });
    mkdirSync(join(h.claude, 'sessions'), { recursive: true });
    writeFileSync(join(h.claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: open.id }));
    const t0 = Date.now();
    await scan(h, { now: () => t0 });
    assert.equal(sent(node).length, 2);
    await scan(h, { now: () => t0 + SCAN_EVERY_MS + 1000 });
    assert.equal(sent(node).length, 2, 'nothing changed within the hour');
    await scan(h, { now: () => t0 + REFRESH_OPEN_MS + SCAN_EVERY_MS });
    assert.deepEqual(node.tool('sessions_report').at(-1).args.sessions.map((s) => s.id), [open.id]);
    assert.ok(!sent(node).slice(2).some((s) => s.id === closed.id));
  } finally {
    await node.close();
  }
});

test('one scan at a time per connection: a second process finds the lock held and skips', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    for (let i = 0; i < 3; i++) transcript(h.claude, { ageMs: (i + 1) * DAY });
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = scanTick({
      paths: h.p, harness: 'claude-code', env: h.env, credentials: { scopes: ['sessions:light'] },
      report: async () => { await gate; return { ok: true }; },
    });
    await new Promise((r) => setTimeout(r, 100));
    const second = await scanTick({ paths: h.p, harness: 'claude-code', env: h.env, credentials: { scopes: ['sessions:light'] }, report: async () => ({ ok: true }) });
    assert.equal(second.ran, false);
    release();
    assert.equal((await slow).reported, 3);
  } finally {
    await node.close();
  }
});

// A pid no process has: what a killed terminal leaves behind in a marker or a poller record.
const DEAD_PID = 2147483000;

test('a hooked session whose harness died without SessionEnd is closed and cannot take tasks', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const crashed = transcript(h.claude, { project: 'atlas-demo', prompt: 'Refactor the export job', ageMs: 2 * 60 * 60 * 1000 });
    touchSession(h.p, crashed.id, { harness: 'claude-code', cwd: '/home/eier/work/atlas-demo', transcriptPath: crashed.path });
    claimPoller(h.p, crashed.id, { pid: DEAD_PID });
    mkdirSync(join(h.claude, 'sessions'), { recursive: true });
    writeFileSync(join(h.claude, 'sessions', `${DEAD_PID}.json`), JSON.stringify({ pid: DEAD_PID, sessionId: crashed.id }));
    await scan(h);
    const got = byId(node).get(crashed.id);
    assert.deepEqual([got.state, got.can_take_tasks], ['closed', false]);
  } finally {
    await node.close();
  }
});

test('a hooked session whose poller process is gone cannot take tasks, and with nothing else running it is closed', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const gone = transcript(h.claude, { project: 'atlas-demo', prompt: 'Tidy the migrations', ageMs: 2 * 60 * 60 * 1000 });
    touchSession(h.p, gone.id, { harness: 'claude-code', cwd: '/home/eier/work/atlas-demo', transcriptPath: gone.path });
    claimPoller(h.p, gone.id, { pid: DEAD_PID });
    // still running (Claude Code's own mark is live), but its poller is gone: open, no tasks
    const idle = transcript(h.claude, { project: 'crm-demo', prompt: 'Map the stage names', ageMs: 2 * 60 * 60 * 1000 });
    touchSession(h.p, idle.id, { harness: 'claude-code', cwd: '/home/eier/work/crm-demo', transcriptPath: idle.path });
    claimPoller(h.p, idle.id, { pid: DEAD_PID });
    mkdirSync(join(h.claude, 'sessions'), { recursive: true });
    writeFileSync(join(h.claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: idle.id }));
    await scan(h);
    const got = byId(node);
    assert.deepEqual([got.get(gone.id).state, got.get(gone.id).can_take_tasks], ['closed', false]);
    assert.deepEqual([got.get(idle.id).state, got.get(idle.id).can_take_tasks], ['open', false]);
  } finally {
    await node.close();
  }
});

test('a poller paused for the person\'s own turn: able to take a task while the turn runs, closed once nothing writes and nothing runs', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const busy = transcript(h.claude, { project: 'atlas-demo', prompt: 'Run the full suite' });
    touchSession(h.p, busy.id, { harness: 'claude-code', cwd: '/home/eier/work/atlas-demo', transcriptPath: busy.path });
    claimPoller(h.p, busy.id, { pid: null });
    const stuck = transcript(h.claude, { project: 'crm-demo', prompt: 'Clean the import', ageMs: 2 * 60 * 60 * 1000 });
    touchSession(h.p, stuck.id, { harness: 'claude-code', cwd: '/home/eier/work/crm-demo', transcriptPath: stuck.path });
    claimPoller(h.p, stuck.id, { pid: null });
    await scan(h);
    const got = byId(node);
    assert.deepEqual([got.get(busy.id).state, got.get(busy.id).can_take_tasks], ['open', true]);
    assert.deepEqual([got.get(stuck.id).state, got.get(stuck.id).can_take_tasks], ['closed', false]);
  } finally {
    await node.close();
  }
});

test('Codex: can_take_tasks follows the detached poller\'s process, not only its record', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const day = join(h.codex, 'sessions', '2026', '09', '22');
    mkdirSync(day, { recursive: true });
    const ids = ['0190c0de-0000-7000-8000-0000000000d1', '0190c0de-0000-7000-8000-0000000000d2'];
    const src = readFileSync(join(FIX, 'codex-rollout.jsonl'), 'utf8');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const id of ids) {
      const path = join(day, `rollout-2026-09-22T09-00-00-${id}.jsonl`);
      writeFileSync(path, src.replaceAll('0190c0de-0000-7000-8000-00000000c0de', id));
      utimesSync(path, old, old);
      touchSession(h.p, id, { harness: 'codex', cwd: '/home/eier/work/atlas-demo', transcriptPath: path });
    }
    claimPoller(h.p, ids[0]);
    claimPoller(h.p, ids[1], { pid: DEAD_PID });
    await scanSessions(h.p, { harness: 'codex', env: h.env });
    const got = byId(node);
    assert.deepEqual([got.get(ids[0]).state, got.get(ids[0]).can_take_tasks], ['open', true]);
    assert.deepEqual([got.get(ids[1]).state, got.get(ids[1]).can_take_tasks], ['closed', false]);
  } finally {
    await node.close();
  }
});

test('a hooked session\'s own report and the scan agree on when it was last active', async () => {
  const node = await startFakeNode();
  try {
    const h = home(node);
    const s = transcript(h.claude, { project: 'atlas-demo', prompt: 'Write the changelog' });
    // the last hook ran half an hour ago; the transcript was written since
    touchSession(h.p, s.id, { harness: 'claude-code', cwd: '/home/eier/work/atlas-demo', transcriptPath: s.path, now: Date.now() - 30 * 60_000 });
    claimPoller(h.p, s.id);
    await reportSession(h.p, s.id, { env: h.env });
    await scan(h);
    const times = sent(node).filter((x) => x.id === s.id).map((x) => x.last_active_at);
    assert.equal(times.length, 2);
    assert.equal(times[0], times[1]);
  } finally {
    await node.close();
  }
});
