// The session bridge: the person's Wybe colleague can see the open Claude Code and Codex sessions
// on this machine, send one a task, and read the result. Per connection (lib/connections.js), per
// session, under <connection>/bridge/:
//   <session>/session.json  { harness, cwd, transcriptPath, startedAt, lastActiveAt, state, title }
//   <session>/poller.json   { token, pid }: the one poller this session has; a newer token supersedes it
//   <session>/tasks.json    { tasks: { <id>: task }, acks: [{ id, outcome }], pendingNotices: [<id>] }
//   claims/<task id>        an untargeted task belongs to the first session that claims it
// Every other session still on disk (opened before the plugin, or closed) is reported by the
// poller's scan in batches (lib/session-scan.js), open first, each with can_take_tasks.
// The node's tools (its assistant MCP door):
//   sessions_report { sessions: [entries, lib/session-info.js + can_take_tasks, summary] }  idempotent by session id
//   inbox { session_id, ack? }  -> { level, tasks: [{ id, text, mode: run|confirm, session_id, expires_at }] }
//                               a task stays in the inbox until it is acked or has a result
//   task_result { task_id, session_id, status: done|failed|refused, text }  once per task
// Access levels are the node's: level read delivers nothing; mode run carries the task text (the
// person already said yes to the colleague); mode confirm carries only the id, and the plugin's
// `take_task` tool shows the text to the person before anything happens (lib/mcp-proxy.js).
// A task's life here: offered (confirm, waiting for take_task) | delivered (the notice is on its way
// to the session) | running (the session works on it) -> finished (the result is written, waiting to
// be sent) -> reported. Everything sent passes through lib/redact.js; tokens stay in the headers.

import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { readJson, writeJsonPrivate, loadCredentials, saveCredentials } from './home.js';
import { callTool } from './post.js';
import { refreshTokens } from './oauth.js';
import { redact, redactValue } from './redact.js';
import { withLock, isAlive } from './lock.js';
import { sessionInfo } from './session-info.js';
import { scanTick, scanDue, summaryOf } from './session-scan.js';

export const POLL_MS = 20_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const REPORT_EVERY_MS = 5 * 60_000;
export const IDLE_LIMIT_MS = 24 * 60 * 60_000;
export const RESULT_MAX = 20_000;
export const MAX_ACKS = 20;
export const KEEP_TASKS_MS = 7 * 24 * 60 * 60_000;
export const TASK_TEXT_MAX = 8000;
export const POLL_ENV = 'WYBE_CONNECT_POLL_MS';
const CALL_TIMEOUT_MS = 15_000;
const TASK_ID = /^[A-Za-z0-9-]{1,64}$/;
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${SEPARATORS}]+`, 'g');

const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
const iso = (ms) => new Date(ms).toISOString();

export const taskMark = (id) => `[wybe-task ${id}]`;

/** The bridge directory of a connection; null for a session without one. */
export function bridgeDir(p) {
  return p?.credentials ? join(dirname(p.credentials), 'bridge') : null;
}

export function sessionFiles(p, sessionId) {
  const dir = join(bridgeDir(p), safeId(sessionId));
  return { dir, session: join(dir, 'session.json'), poller: join(dir, 'poller.json'), tasks: join(dir, 'tasks.json'), lock: join(dir, 'tasks.lock') };
}

function quietJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function credentialsOf(p) {
  try {
    return p?.credentials ? loadCredentials(p) : null;
  } catch {
    return null;
  }
}

const emptyTasks = () => ({ tasks: {}, acks: [], pendingNotices: [] });

function readTasks(f) {
  const t = quietJson(f.tasks);
  if (!t || typeof t !== 'object' || typeof t.tasks !== 'object' || t.tasks === null) return emptyTasks();
  return { tasks: t.tasks, acks: Array.isArray(t.acks) ? t.acks : [], pendingNotices: Array.isArray(t.pendingNotices) ? t.pendingNotices : [] };
}

/** Read-modify-write of a session's tasks under its lock. fn(state) may return a value. */
function withTasks(p, sessionId, fn) {
  const f = sessionFiles(p, sessionId);
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  return withLock(f.lock, () => {
    const st = readTasks(f);
    const out = fn(st);
    writeJsonPrivate(f.tasks, st);
    return out;
  });
}

// ------------------------------------------------------------------ the session record

export function readSession(p, sessionId) {
  return bridgeDir(p) ? quietJson(sessionFiles(p, sessionId).session) : null;
}

/** Notes that a hook saw the session: open (or closed), active now. Returns the record. */
export function touchSession(p, sessionId, { harness, cwd = null, transcriptPath = null, now = Date.now(), closed = false } = {}) {
  if (!bridgeDir(p) || !sessionId) return null;
  const f = sessionFiles(p, sessionId);
  const old = quietJson(f.session) ?? {};
  const rec = {
    harness: harness ?? old.harness,
    cwd: typeof cwd === 'string' ? cwd : old.cwd ?? null,
    transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : old.transcriptPath ?? null,
    startedAt: old.startedAt ?? iso(now),
    lastActiveAt: iso(now),
    state: closed ? 'closed' : 'open',
    title: old.title ?? null,
    reportedAt: old.reportedAt ?? null,
  };
  writeJsonPrivate(f.session, rec);
  return rec;
}

// ------------------------------------------------------------------ the poller token

/** Makes the caller this session's poller; any older poller sees a token not its own and stops. */
export function claimPoller(p, sessionId, { pid = process.pid } = {}) {
  const token = randomBytes(12).toString('hex');
  writeJsonPrivate(sessionFiles(p, sessionId).poller, { token, pid, at: new Date().toISOString() });
  return token;
}

/** Stops whatever poller the session has (a newer token with no process behind it). */
export function pausePoller(p, sessionId) {
  if (!bridgeDir(p) || !sessionId) return;
  claimPoller(p, sessionId, { pid: null });
}

export function isCurrentPoller(p, sessionId, token) {
  return quietJson(sessionFiles(p, sessionId).poller)?.token === token;
}

export function pollerAlive(p, sessionId, alive = isAlive) {
  const pid = quietJson(sessionFiles(p, sessionId).poller)?.pid;
  return Number.isInteger(pid) && alive(pid);
}

// ------------------------------------------------------------------ calls to the node

/** The JSON a node tool answered with (structuredContent, or the text block parsed). */
export function dataOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const t = Array.isArray(result?.content) ? result.content.find((c) => c?.type === 'text')?.text : undefined;
  try {
    return typeof t === 'string' ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

/**
 * One node tool call with the connection's grant: arguments redacted first (a value the walker
 * cannot read is never sent), one refresh on an auth refusal, stored only while the file still
 * holds the grant the call started with. Returns { ok, data } or { ok: false, kind, toolError? }.
 */
export async function nodeCall(p, name, args, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = CALL_TIMEOUT_MS, redactOptions = {} } = {}) {
  let c = credentialsOf(p);
  if (!c) return { ok: false, kind: 'not-connected' };
  let safe;
  try {
    safe = redactValue(args, redactOptions).value;
  } catch {
    return { ok: false, kind: 'unsafe' };
  }
  const attempt = (creds) => callTool({ endpoint: creds.mcpEndpoint, accessToken: creds.accessToken, name, args: safe, fetchImpl, timeoutMs });
  let out = await attempt(c);
  if (!out.ok && out.kind === 'auth' && c.refreshToken) {
    const next = await refreshTokens({ tokenEndpoint: c.tokenEndpoint, clientId: c.clientId, refreshToken: c.refreshToken, resource: c.resource ?? c.mcpEndpoint, requestedScopes: c.scopes, fetchImpl, now: now() });
    if (next) {
      c = { ...c, ...next };
      const onDisk = quietJson(p.credentials);
      if (onDisk && (onDisk.grantId ?? null) === (c.grantId ?? null)) saveCredentials(c, p);
      out = await attempt(c);
    }
  }
  if (!out.ok) return out;
  return { ok: true, data: dataOf(out.result) };
}

export const hasSessionScope = (c) => Array.isArray(c?.scopes) && (c.scopes.includes('sessions:light') || c.scopes.includes('sessions:full'));

function writtenAt(path) {
  if (typeof path !== 'string' || !path) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** sessions_report for this one session, from its record. The account is display only, so e-mail addresses stay; secrets do not. */
export async function reportSession(p, sessionId, { env = process.env, home, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const rec = readSession(p, sessionId);
  if (!rec || !hasSessionScope(credentialsOf(p))) return { ok: false, kind: 'skipped' };
  const f = sessionFiles(p, sessionId);
  // the later of the last hook and the last transcript write, as the scan (lib/session-scan.js) sends it
  const written = writtenAt(rec.transcriptPath);
  const lastActiveAt = written > (Date.parse(rec.lastActiveAt) || 0) ? iso(written) : rec.lastActiveAt;
  const info = sessionInfo({
    harness: rec.harness, sessionId, cwd: rec.cwd, transcriptPath: rec.transcriptPath, env, ...(home ? { home } : {}),
    startedAt: rec.startedAt, lastActiveAt, state: rec.state, ...(rec.title ? { title: rec.title } : {}),
  });
  // a hooked session not ended can take a task: its poller runs at each turn's end
  info.can_take_tasks = rec.state === 'open';
  if (credentialsOf(p)?.scopes?.includes('sessions:full')) {
    const summary = summaryOf(p, sessionId);
    if (summary) info.summary = summary;
  }
  const out = await nodeCall(p, 'sessions_report', { sessions: [info] }, { fetchImpl, now, redactOptions: { emails: false } });
  const after = quietJson(f.session);
  if (after) writeJsonPrivate(f.session, { ...after, title: after.title ?? info.title ?? null, ...(out.ok ? { reportedAt: iso(now()) } : {}) });
  return out;
}

/**
 * One scan of every `harness` session on disk for this connection (lib/session-scan.js), when one is due: the
 * changed ones go in one sessions_report. Never throws.
 */
export async function scanSessions(p, { harness, env = process.env, home, fetchImpl = globalThis.fetch, now = Date.now, ...rest } = {}) {
  try {
    if (!bridgeDir(p) || !scanDue(p, { now: now() })) return { ran: false, reported: 0, backlog: 0 };
    return await scanTick({
      paths: p, harness, credentials: credentialsOf(p), env, ...(home ? { home } : {}), now, ...rest,
      report: (sessions) => nodeCall(p, 'sessions_report', { sessions }, { fetchImpl, now, redactOptions: { emails: false } }),
      bridgeRecord: (id) => readSession(p, id),
      pollerOf: (id) => quietJson(sessionFiles(p, id).poller),
    });
  } catch {
    return { ran: false, reported: 0, backlog: 0 };
  }
}

// ------------------------------------------------------------------ tasks

const oneLine = (s) => String(s).replace(CONTROL, ' ');

/** The text a session is woken with. A confirm task's text is never in it. */
export function noticeFor(task) {
  const mark = taskMark(task.id);
  if (task.mode === 'run') {
    const text = oneLine(task.text).slice(0, TASK_TEXT_MAX);
    return `${mark} A task from the person's Wybe AI colleague. The person already said yes to their Wybe colleague: «${text}». Do it now in this session. When you finish, end with a short summary of what you did; it is sent back to the colleague.`;
  }
  return `${mark} The person's Wybe AI colleague has a task for this session that needs the person's yes first. Call the \`wybe\` MCP tool \`take_task\` with task_id "${task.id}": it shows the exact task to the person. Do nothing for it until take_task says the person accepted.`;
}

function claim(p, taskId, sessionId) {
  const dir = join(bridgeDir(p), 'claims');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, safeId(taskId));
  try {
    writeFileSync(file, sessionId, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') return false;
    try {
      return readFileSync(file, 'utf8') === sessionId;
    } catch {
      return false;
    }
  }
}

function prune(st, now) {
  for (const [id, t] of Object.entries(st.tasks)) {
    if (t.status === 'reported' && now - Date.parse(t.reportedAt ?? t.seenAt ?? 0) > KEEP_TASKS_MS) delete st.tasks[id];
  }
}

/**
 * One inbox call for this session, carrying the acks waiting to go. New tasks are recorded (a run
 * task as `runStatus`: 'running' when the session is idle and is woken now, 'delivered' when the
 * notice is queued for its next turn) and returned; a task seen before, expired, meant for another
 * session or claimed by another session is not. With `token`, only the current poller records.
 * Returns { ok, level, tasks } or { ok: false, kind }.
 */
export async function pollOnce(p, sessionId, { runStatus = 'running', token = null, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  // Tasks to a session are part of the sessions:* grant, like the report: without it, no inbox call.
  if (!hasSessionScope(credentialsOf(p))) return { ok: false, kind: 'skipped' };
  const f = sessionFiles(p, sessionId);
  const acks = readTasks(f).acks.slice(0, MAX_ACKS);
  const args = { session_id: sessionId, ...(acks.length ? { ack: acks } : {}) };
  const out = await nodeCall(p, 'inbox', args, { fetchImpl, now });
  if (!out.ok) return out;
  const data = out.data ?? {};
  const level = typeof data.level === 'string' ? data.level : null;
  const t = now();
  const fresh = withTasks(p, sessionId, (st) => {
    const sent = new Set(acks.map((a) => `${a.id}:${a.outcome}`));
    st.acks = st.acks.filter((a) => !sent.has(`${a.id}:${a.outcome}`));
    prune(st, t);
    if (token && !isCurrentPoller(p, sessionId, token)) return [];
    if (level === 'read' || !Array.isArray(data.tasks)) return [];
    const added = [];
    for (const raw of data.tasks) {
      const id = typeof raw?.id === 'string' ? raw.id : '';
      if (!TASK_ID.test(id) || st.tasks[id]) continue;
      if (typeof raw.text !== 'string' || !raw.text.trim()) continue;
      if (raw.mode !== 'run' && raw.mode !== 'confirm') continue;
      if (typeof raw.expires_at === 'string' && Date.parse(raw.expires_at) <= t) continue;
      if (typeof raw.session_id === 'string' && raw.session_id && raw.session_id !== sessionId) continue;
      if (!raw.session_id && !claim(p, id, sessionId)) continue;
      const task = {
        id, sessionId, mode: raw.mode, text: raw.text.slice(0, TASK_TEXT_MAX),
        status: raw.mode === 'run' ? runStatus : 'offered',
        expiresAt: typeof raw.expires_at === 'string' ? raw.expires_at : null, seenAt: iso(t),
      };
      st.tasks[id] = task;
      if (raw.mode === 'run') st.acks.push({ id, outcome: 'accepted' });
      added.push(task);
    }
    return added;
  });
  return { ok: true, level, tasks: fresh };
}

/** A notice that could not be queued into the session: the next Stop hook hands it over instead. */
export function leaveNotice(p, sessionId, taskId) {
  withTasks(p, sessionId, (st) => {
    if (st.tasks[taskId] && !st.pendingNotices.includes(taskId)) st.pendingNotices.push(taskId);
  });
}

/** The notices left for the Stop hook, once: those tasks count as running from here (the next turn is theirs). */
export function takeNotices(p, sessionId) {
  if (!bridgeDir(p) || !existsSync(sessionFiles(p, sessionId).tasks)) return [];
  return withTasks(p, sessionId, (st) => {
    const out = [];
    for (const id of st.pendingNotices) {
      const task = st.tasks[id];
      if (!task || (task.status !== 'delivered' && task.status !== 'offered')) continue;
      if (task.status === 'delivered') task.status = 'running';
      out.push(noticeFor(task));
    }
    st.pendingNotices = [];
    return out;
  });
}

/**
 * A turn ended (Stop, or StopFailure with failed: true). Every running task gets its result:
 * redact(lastMessage), at most RESULT_MAX characters. A delivered task (queued for a turn of its
 * own) is finished only by the turn whose prompt carries its mark; `turnPrompt` null means that
 * prompt could not be read, and then the turn is taken to be the task's.
 */
export function finishOnStop(p, sessionId, { lastMessage = '', failed = false, turnPrompt = undefined, now = Date.now } = {}) {
  if (!bridgeDir(p) || !existsSync(sessionFiles(p, sessionId).tasks)) return 0;
  const text = redact(typeof lastMessage === 'string' ? lastMessage : '').text.slice(0, RESULT_MAX);
  return withTasks(p, sessionId, (st) => {
    let n = 0;
    for (const task of Object.values(st.tasks)) {
      if (st.pendingNotices.includes(task.id)) continue; // its notice has not reached the session yet
      const ours = task.status === 'running'
        || (task.status === 'delivered' && turnPrompt !== undefined && (turnPrompt === null || turnPrompt.includes(taskMark(task.id))));
      if (!ours) continue;
      task.status = 'finished';
      task.result = { status: failed ? 'failed' : 'done', text };
      task.finishedAt = iso(now());
      n += 1;
    }
    return n;
  });
}

/**
 * A refusal that says the node is busy for now (its budget or rate limit): `retry: true` on the answer, or failing
 * that, the words "try again later". The call may succeed later exactly as it is.
 */
export const busyRefusal = (out) => !out.ok && out.toolError === true && (out.retry === true || /try again later/i.test(String(out.message ?? '')));

/**
 * Sends every finished result; one the node refuses (already has one, not this session's) is settled too. One the
 * node is too busy to take now (busyRefusal) waits for the next round.
 */
export async function flushResults(p, sessionId, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!bridgeDir(p) || !existsSync(sessionFiles(p, sessionId).tasks)) return 0;
  const waiting = Object.values(readTasks(sessionFiles(p, sessionId)).tasks).filter((t) => t.status === 'finished' && t.result);
  let sent = 0;
  for (const task of waiting) {
    const out = await nodeCall(p, 'task_result', { task_id: task.id, session_id: sessionId, status: task.result.status, text: task.result.text }, { fetchImpl, now });
    if ((!out.ok && !out.toolError) || busyRefusal(out)) continue;
    withTasks(p, sessionId, (st) => {
      const t = st.tasks[task.id];
      if (t && t.status === 'finished') {
        t.status = 'reported';
        t.reportedAt = iso(now());
        delete t.result;
        delete t.text;
      }
    });
    if (out.ok) sent += 1;
  }
  return sent;
}

/** A task of this connection by id, in whichever session got it: { sessionId, task } or null. */
export function findTask(p, taskId) {
  const dir = bridgeDir(p);
  if (!dir || !existsSync(dir) || typeof taskId !== 'string' || !TASK_ID.test(taskId)) return null;
  for (const d of readdirSync(dir)) {
    if (d === 'claims') continue;
    const st = readTasks({ tasks: join(dir, d, 'tasks.json') });
    const task = st.tasks[taskId];
    if (task) return { sessionId: typeof task.sessionId === 'string' ? task.sessionId : d, task };
  }
  return null;
}

/** take_task's decision: accepted -> running (and acked), refused -> the refused result is sent now. */
export async function decideTask(p, sessionId, taskId, accepted, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const ok = withTasks(p, sessionId, (st) => {
    const t = st.tasks[taskId];
    if (!t || t.status !== 'offered') return false;
    if (accepted) {
      t.status = 'running';
      st.acks.push({ id: taskId, outcome: 'accepted' });
    } else {
      t.status = 'finished';
      t.result = { status: 'refused', text: 'The person declined the task in the session.' };
      t.finishedAt = iso(now());
    }
    return true;
  });
  if (ok && !accepted) await flushResults(p, sessionId, { fetchImpl, now });
  return ok;
}

// ------------------------------------------------------------------ the poller

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pollInterval(env = process.env) {
  const v = Number(env[POLL_ENV]);
  return Number.isFinite(v) && v >= 50 ? v : POLL_MS;
}

/**
 * Polls the node for this session until a reason to stop: 'superseded' (a newer poller),
 * 'closed' (SessionEnd), 'gone' (the connection or the session record is gone), 'idle' (no
 * activity for IDLE_LIMIT_MS), or 'stop' (onTasks asked to: Claude Code exits to wake the session).
 * Each round: the results waiting, a sessions_report every REPORT_EVERY_MS (and at start), with `harness` a scan
 * of every session of that harness on disk when one is due (scanSessions), then the inbox. onTasks(tasks) returns 'stop' or 'continue'. The node down: backoff up to MAX_BACKOFF_MS.
 */
export async function runPoller({ paths: p, sessionId, harness = null, runStatus = 'running', onTasks, env = process.env, home, fetchImpl = globalThis.fetch, now = Date.now, sleep = defaultSleep, intervalMs = pollInterval(env), reportEveryMs = REPORT_EVERY_MS } = {}) {
  if (!bridgeDir(p) || !sessionId) return { exit: 'gone' };
  const token = claimPoller(p, sessionId);
  let lastReport = -Infinity;
  let wait = intervalMs;
  const stopReason = () => {
    if (!isCurrentPoller(p, sessionId, token)) return 'superseded';
    const rec = readSession(p, sessionId);
    if (!rec || !credentialsOf(p)) return 'gone';
    if (rec.state === 'closed') return 'closed';
    if (now() - Date.parse(rec.lastActiveAt) > IDLE_LIMIT_MS) return 'idle';
    return null;
  };
  for (;;) {
    const why = stopReason();
    if (why) return { exit: why };
    await flushResults(p, sessionId, { fetchImpl, now });
    if (now() - lastReport >= reportEveryMs) {
      const r = await reportSession(p, sessionId, { env, home, fetchImpl, now });
      if (r.ok || r.kind === 'skipped') lastReport = now();
    }
    if (harness) await scanSessions(p, { harness, env, home, fetchImpl, now });
    const out = await pollOnce(p, sessionId, { runStatus, token, fetchImpl, now });
    if (out.ok) {
      wait = intervalMs;
      if (out.tasks.length) {
        const again = stopReason();
        if (again) return { exit: again };
        if ((await onTasks(out.tasks)) === 'stop') return { exit: 'stop', tasks: out.tasks };
      }
    } else {
      wait = Math.min(Math.max(wait * 2, intervalMs), Math.max(MAX_BACKOFF_MS, intervalMs));
    }
    // sleep in slices, so a superseded or closed poller stops within a second
    const until = now() + wait;
    while (now() < until) {
      if (stopReason()) break;
      await sleep(Math.min(1000, Math.max(10, until - now())));
    }
  }
}
