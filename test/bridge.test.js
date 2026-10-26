// The session bridge against a fake node on 127.0.0.1 (test/fixtures/fake-node.mjs): inbox polls,
// the access levels, acks, results, the superseding poller, and what may leave the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { connectionPaths } from '../lib/connections.js';
import { saveCredentials, loadCredentials } from '../lib/home.js';
import {
  pollOnce, noticeFor, taskMark, touchSession, reportSession, finishOnStop, flushResults, runPoller, findTask,
  decideTask, leaveNotice, takeNotices, claimPoller, pausePoller, readSession, RESULT_MAX,
} from '../lib/bridge.js';
import { startFakeNode, grantFor, TOKEN, REFRESH, NEW_TOKEN } from './fixtures/fake-node.mjs';

const SID = 'sess-aaaa-0001';
const OTHER = 'sess-bbbb-0002';
const SECRET = ['sk-ant-api03-', 'Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7Zy6Xw5Vu4Ts3Rq2Po1Nm0Lk9Ji8Hg7Fe6Dc5Ba4-AAAAAAAA'].join('');

function setup(node, over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-bridge-'));
  const p = connectionPaths(root, 'node-a');
  saveCredentials(grantFor(node, over), p);
  const claude = mkdtempSync(join(tmpdir(), 'wybe-connect-claude-'));
  writeFileSync(join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'eier@example.invalid' } }));
  return { root, p, env: { CLAUDE_CONFIG_DIR: claude } };
}

const task = (over = {}) => ({ id: randomUUID(), text: 'Oppsummer endringene i PR-en og foreslå en tittel', mode: 'run', session_id: SID, ...over });

test('run mode: the notice carries the task text; the task is acked as accepted on the next inbox call, and never delivered twice', async () => {
  const node = await startFakeNode();
  try {
    const { p } = setup(node);
    const t = task();
    node.tasks.push(t);
    const first = await pollOnce(p, SID);
    assert.equal(first.ok, true);
    assert.deepEqual(first.tasks.map((x) => x.id), [t.id]);
    const notice = noticeFor(first.tasks[0]);
    assert.ok(notice.includes(t.text) && notice.includes(taskMark(t.id)));
    assert.match(notice, /already said yes to their Wybe colleague/);
    assert.deepEqual(node.tool('inbox')[0].args, { session_id: SID });
    const second = await pollOnce(p, SID);
    assert.deepEqual(second.tasks, [], 'the same task again is not new');
    assert.deepEqual(node.tool('inbox')[1].args, { session_id: SID, ack: [{ id: t.id, outcome: 'accepted' }] });
    await pollOnce(p, SID);
    assert.deepEqual(node.tool('inbox')[2].args, { session_id: SID }, 'an ack is sent once');
  } finally {
    await node.close();
  }
});

test('confirm mode: the notice never carries the task text, only the id and take_task; the text waits locally for take_task', async () => {
  const node = await startFakeNode();
  try {
    const { p } = setup(node);
    const t = task({ mode: 'confirm', text: 'Slett grenen feature/gammel og push' });
    node.tasks.push(t);
    const r = await pollOnce(p, SID);
    const notice = noticeFor(r.tasks[0]);
    assert.ok(!notice.includes(t.text));
    assert.ok(!notice.includes('feature/gammel'));
    assert.match(notice, /take_task/);
    assert.ok(notice.includes(t.id));
    assert.equal(findTask(p, t.id).task.status, 'offered');
    assert.equal(findTask(p, t.id).sessionId, SID);
    await pollOnce(p, SID);
    assert.equal(node.tool('inbox')[1].args.ack, undefined, 'a confirm task is not acked before the person decides');
  } finally {
    await node.close();
  }
});

test('level read: nothing is ever delivered', async () => {
  const node = await startFakeNode({ level: 'read' });
  try {
    const { p } = setup(node);
    node.tasks.push(task());
    node.level = 'read';
    const r = await pollOnce(p, SID);
    assert.equal(r.level, 'read');
    assert.deepEqual(r.tasks, []);
  } finally {
    await node.close();
  }
});

test('an untargeted task goes to one session only; expired, foreign and malformed tasks are skipped', async () => {
  const node = await startFakeNode();
  try {
    const { p } = setup(node);
    const open = task({ session_id: null });
    node.tasks.push(open, task({ expires_at: '2000-01-01T00:00:00.000Z' }), task({ id: 'bad id/..' }), task({ mode: 'other' }));
    const a = await pollOnce(p, SID);
    const b = await pollOnce(p, OTHER);
    assert.deepEqual(a.tasks.map((x) => x.id), [open.id]);
    assert.deepEqual(b.tasks, []);
    const foreign = task({ session_id: OTHER });
    node.tasks.push(foreign);
    assert.deepEqual((await pollOnce(p, SID)).tasks, [], 'a task for another session is not ours (the fake node filters, and so do we)');
  } finally {
    await node.close();
  }
});

test('a result: the next Stop sends task_result done with the redacted last message, cut to 20 000; once', async () => {
  const node = await startFakeNode();
  try {
    const { p } = setup(node);
    const t = task();
    node.tasks.push(t);
    await pollOnce(p, SID);
    assert.equal(finishOnStop(p, SID, { lastMessage: `Ferdig. Nøkkelen var ${SECRET}. ${'x'.repeat(30_000)}` }), 1);
    assert.equal(await flushResults(p, SID), 1);
    const sent = node.tool('task_result')[0].args;
    assert.equal(sent.task_id, t.id);
    assert.equal(sent.session_id, SID);
    assert.equal(sent.status, 'done');
    assert.ok(!sent.text.includes(SECRET), 'redacted');
    assert.ok(sent.text.startsWith('Ferdig.'));
    assert.ok(sent.text.length <= RESULT_MAX);
    assert.equal(finishOnStop(p, SID, { lastMessage: 'later' }), 0);
    assert.equal(await flushResults(p, SID), 0);
    assert.equal(node.tool('task_result').length, 1);
  } finally {
    await node.close();
  }
});

test('a failed turn sends failed; the node down keeps the result for the next round', async () => {
  const node = await startFakeNode();
  try {
    const { p } = setup(node);
    const t = task();
    node.tasks.push(t);
    await pollOnce(p, SID);
    finishOnStop(p, SID, { lastMessage: 'API error', failed: true });
    node.down = true;
    assert.equal(await flushResults(p, SID), 0);
    node.down = false;
    assert.equal(await flushResults(p, SID), 1);
    assert.equal(node.tool('task_result')[0].args.status, 'failed');
  } finally {
    await node.close();
  }
});

test('a task queued for a turn of its own is finished only by the turn whose prompt carries its mark', async () => {
  const node = await startFakeNode();
  try {
    const { p } = setup(node);
    const t = task();
    node.tasks.push(t);
    await pollOnce(p, SID, { runStatus: 'delivered' });
    assert.equal(finishOnStop(p, SID, { lastMessage: 'the person\'s own turn', turnPrompt: 'fix the tests' }), 0);
    assert.equal(finishOnStop(p, SID, { lastMessage: 'no prompt info' }), 0, 'Claude Code passes no turn prompt: delivered stays delivered');
    assert.equal(finishOnStop(p, SID, { lastMessage: 'done it', turnPrompt: noticeFor(findTask(p, t.id).task) }), 1);
    await flushResults(p, SID);
    assert.equal(node.tool('task_result')[0].args.text, 'done it');
  } finally {
    await node.close();
  }
});

test('a notice left for the Stop hook is handed over once, and its task then counts as running', async () => {
  const node = await startFakeNode();
  try {
    const { p } = setup(node);
    const t = task();
    node.tasks.push(t);
    await pollOnce(p, SID, { runStatus: 'delivered' });
    leaveNotice(p, SID, t.id);
    const notices = takeNotices(p, SID);
    assert.equal(notices.length, 1);
    assert.ok(notices[0].includes(t.text));
    assert.deepEqual(takeNotices(p, SID), []);
    assert.equal(findTask(p, t.id).task.status, 'running');
  } finally {
    await node.close();
  }
});

test('take_task decisions: accept makes it running and acks it; a no sends refused at once', async () => {
  const node = await startFakeNode();
  try {
    const { p } = setup(node);
    const yes = task({ mode: 'confirm' });
    const no = task({ mode: 'confirm' });
    node.tasks.push(yes, no);
    await pollOnce(p, SID);
    assert.equal(await decideTask(p, SID, yes.id, true), true);
    assert.equal(findTask(p, yes.id).task.status, 'running');
    assert.equal(await decideTask(p, SID, no.id, false), true);
    assert.deepEqual(node.tool('task_result').map((c) => [c.args.task_id, c.args.status]), [[no.id, 'refused']]);
    assert.equal(await decideTask(p, SID, yes.id, true), false, 'decided once');
    await pollOnce(p, SID);
    assert.deepEqual(node.tool('inbox').at(-1).args.ack, [{ id: yes.id, outcome: 'accepted' }]);
  } finally {
    await node.close();
  }
});

test('sessions_report: project is the basename, the account the local label, idempotent; skipped without a sessions scope', async () => {
  const node = await startFakeNode();
  try {
    const { p, env } = setup(node);
    touchSession(p, SID, { harness: 'claude-code', cwd: join(tmpdir(), 'work', 'demo-app'), transcriptPath: join(import.meta.dirname, 'fixtures', 'session.jsonl') });
    assert.equal((await reportSession(p, SID, { env })).ok, true);
    assert.equal((await reportSession(p, SID, { env })).ok, true);
    const [one, two] = node.tool('sessions_report').map((c) => c.args.sessions);
    assert.equal(one.length, 1);
    assert.equal(one[0].id, SID);
    assert.equal(one[0].project, 'demo-app');
    assert.equal(one[0].account, 'eier@example.invalid');
    assert.equal(one[0].state, 'open');
    assert.ok(one[0].title.startsWith('Add a retry'));
    assert.ok(!JSON.stringify(one).includes(tmpdir()), 'no local path');
    assert.deepEqual(one, two);
    touchSession(p, SID, { closed: true });
    await reportSession(p, SID, { env });
    assert.equal(node.tool('sessions_report')[2].args.sessions[0].state, 'closed');

    const light = setup(node, { scopes: ['remember'] });
    touchSession(light.p, SID, { harness: 'codex', cwd: '/x/y' });
    assert.equal((await reportSession(light.p, SID, { env })).kind, 'skipped');
  } finally {
    await node.close();
  }
});

test('a 401 refreshes once and stores the new grant; a grant replaced meanwhile is never written over', async () => {
  const node = await startFakeNode();
  try {
    const { p } = setup(node);
    node.valid = 'something-else';
    // the fake token endpoint makes NEW_TOKEN the valid one
    assert.equal((await pollOnce(p, SID)).ok, true);
    assert.equal(node.refreshes, 1);
    assert.equal(loadCredentials(p).accessToken, NEW_TOKEN);

    const other = setup(node);
    node.valid = 'again-else';
    const replaced = { ...loadCredentials(other.p), grantId: 'g2', accessToken: 'wat_replaced' };
    const orig = loadCredentials(other.p);
    // the call starts with g1; the file is replaced by g2 before the refresh lands
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/oauth/token')) saveCredentials(replaced, other.p);
      return fetch(url, init);
    };
    assert.equal(orig.grantId, 'g1');
    await pollOnce(other.p, SID, { fetchImpl });
    assert.equal(loadCredentials(other.p).grantId, 'g2');
    assert.equal(loadCredentials(other.p).accessToken, 'wat_replaced');
  } finally {
    await node.close();
  }
});

test('no token or local path in anything sent to the node: only the Authorization header carries the grant', async () => {
  const node = await startFakeNode();
  try {
    const { p, env } = setup(node);
    const codexHome = mkdtempSync(join(tmpdir(), 'wybe-connect-codexhome-'));
    const idToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ email: 'eier@example.invalid' })).toString('base64url')}.c2ln`;
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken, access_token: 'codex-access-planted', refresh_token: 'codex-refresh-planted' } }));
    touchSession(p, SID, { harness: 'codex', cwd: '/home/eier/src/atlas-demo', transcriptPath: join(import.meta.dirname, 'fixtures', 'codex-rollout.jsonl') });
    node.tasks.push(task());
    await reportSession(p, SID, { env: { ...env, CODEX_HOME: codexHome } });
    await pollOnce(p, SID);
    finishOnStop(p, SID, { lastMessage: `done, used ${TOKEN}` });
    await flushResults(p, SID);
    await pollOnce(p, SID);
    const bodies = node.calls.map((c) => c.body).join('\n');
    for (const s of [TOKEN, REFRESH, idToken, 'codex-access-planted', 'codex-refresh-planted', '/home/eier/src']) assert.ok(!bodies.includes(s), `leaked: ${s.slice(0, 12)}`);
    assert.ok(node.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
    assert.equal(node.tool('sessions_report')[0].args.sessions[0].account, 'eier@example.invalid');
  } finally {
    await node.close();
  }
});

test('the poller: a newer poller for the same session makes the older one stop without delivering', async () => {
  const node = await startFakeNode();
  try {
    const { p, env } = setup(node);
    touchSession(p, SID, { harness: 'claude-code', cwd: '/w/demo' });
    const seenByOld = [];
    const old = runPoller({ paths: p, sessionId: SID, env, intervalMs: 50, onTasks: async (t) => { seenByOld.push(...t); return 'stop'; } });
    await new Promise((r) => setTimeout(r, 200));
    const seenByNew = [];
    const fresh = runPoller({ paths: p, sessionId: SID, env, intervalMs: 50, onTasks: async (t) => { seenByNew.push(...t); return 'stop'; } });
    assert.deepEqual(await old, { exit: 'superseded' });
    node.tasks.push(task());
    const r = await fresh;
    assert.equal(r.exit, 'stop');
    assert.equal(seenByNew.length, 1);
    assert.equal(seenByOld.length, 0);
    assert.ok(node.tool('sessions_report').length >= 1, 'a poller reports the session when it starts');
  } finally {
    await node.close();
  }
});

test('the poller stops when the session is closed, paused, or its connection is gone; the node down backs off', async () => {
  const node = await startFakeNode();
  try {
    const { p, env } = setup(node);
    touchSession(p, SID, { harness: 'codex', cwd: '/w/demo' });
    const closing = runPoller({ paths: p, sessionId: SID, env, intervalMs: 50, onTasks: async () => 'continue' });
    await new Promise((r) => setTimeout(r, 150));
    touchSession(p, SID, { closed: true });
    assert.deepEqual(await closing, { exit: 'closed' });
    assert.equal(readSession(p, SID).state, 'closed');

    touchSession(p, OTHER, { harness: 'claude-code', cwd: '/w/demo' });
    const paused = runPoller({ paths: p, sessionId: OTHER, env, intervalMs: 50, onTasks: async () => 'continue' });
    await new Promise((r) => setTimeout(r, 150));
    pausePoller(p, OTHER);
    assert.deepEqual(await paused, { exit: 'superseded' });

    const third = 'sess-cccc-0003';
    touchSession(p, third, { harness: 'claude-code' });
    node.down = true;
    const before = node.bodies.length;
    const down = runPoller({ paths: p, sessionId: third, env, intervalMs: 50, onTasks: async () => 'continue' });
    await new Promise((r) => setTimeout(r, 700));
    const tries = node.bodies.length - before;
    assert.ok(tries <= 12, `backed off (${tries} requests in 0.7 s at a 50 ms interval)`);
    writeFileSync(p.credentials, '{}');
    // a broken grant file means no connection: the poller is gone
    assert.deepEqual(await down, { exit: 'gone' });
    claimPoller(p, third);
  } finally {
    await node.close();
  }
});
