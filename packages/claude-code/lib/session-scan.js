// Every session of the person's on this machine, for their colleague: not only the sessions the
// plugin's hooks ran in, but every Claude Code transcript and Codex rollout still on disk, open or
// closed. lib/bridge.js reports the hooked sessions one by one; this module reports the rest in
// batches through the same sessions_report (idempotent by session id).
//
//   Claude Code  <claude home>/projects/<dir>/<session uuid>.jsonl. Subagent threads live in a
//                folder of their own and are never listed; the distil runs' own sessions are left out.
//   Codex        <codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl and archived_sessions/: the person's
//                threads only (session_meta.source), never a distil run's.
//
// Each entry is what lib/session-info.js sends for a hooked session, plus:
//   state           open while the harness runs it: Claude Code's own <claude home>/sessions/<pid>.json
//                   with a live pid, a transcript written in the last OPEN_RECENT_MS, or a hooked session
//                   not ended, active within the idle limit, whose poller process is alive. Else closed:
//                   a session whose only marks have a dead pid is closed even when its record says open
//                   (a killed terminal sends no SessionEnd). Archived rollouts are closed.
//   can_take_tasks  true only for an open hooked session whose poller can pick a task up: its process
//                   is alive, or it is paused for the person's own turn while that turn still runs
//                   (the next Stop re-arms it). A poller record without its process cannot.
//   summary         with the sessions:full grant only: the short summary the background distil wrote
//                   for the session (redacted when stored). Never transcript text.
//
// Whose sessions: a session belongs to the connection its harness account resolves to
// (lib/connections.js). A pinned session goes only to its pin; an unpinned one only to the
// connection a new session of the current harness account would use. One account's sessions never
// reach another account's connection.
//
// Bounds: a tick lists the folders (asynchronously, never blocking a hook or the MCP server: it runs
// in the session's background poller), reports at most SCAN_BATCH changed sessions in one call (an open
// one also when REFRESH_OPEN_MS passed since it was last sent), and
// only one process scans a connection at a time (a lock taken without waiting). What changed since
// the last report is known from <connection>/bridge/scan.json; a session already reported unchanged
// is not sent again. A tick that leaves a backlog asks for the next one at the next poll round.

import { open, readdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readJson, writeJsonPrivate } from './home.js';
import { acquire, isAlive as defaultAlive } from './lock.js';
import { sessionConnection, NODE_ENV } from './connections.js';
import { accountOf, cleanTitle, projectOf } from './session-info.js';
import { parseTranscript } from './transcript.js';
import { parseRollout, headOf, stripCodexInjected } from './codex-rollout.js';
import { redact } from './redact.js';

export const SCAN_BATCH = 25;
export const SCAN_EVERY_MS = 5 * 60_000;
// An open session is sent again this often while unchanged: the node counts a session open only while it is
// reported or active within a day.
export const REFRESH_OPEN_MS = 60 * 60_000;
export const OPEN_RECENT_MS = 10 * 60_000;
export const IDLE_LIMIT_MS = 24 * 60 * 60_000;
export const SUMMARY_MAX = 600;
const HEAD_BYTES = 256 * 1024;
const DISTIL_PROMPT_START = 'wybe-connect distil run';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${SEPARATORS}]+`, 'g');

const iso = (ms) => new Date(ms).toISOString();

export function claudeHomeOf(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function codexHomeOf(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

function bridgeOf(p) {
  return p?.credentials ? join(dirname(p.credentials), 'bridge') : null;
}

export function scanFiles(p) {
  const dir = bridgeOf(p);
  return { dir, state: join(dir, 'scan.json'), lock: join(dir, 'scan.lock'), summaries: join(dir, 'summaries.json') };
}

function quietJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ summaries

/** One line, redacted, at most SUMMARY_MAX characters; null when nothing is left. */
export function cleanSummary(text) {
  if (typeof text !== 'string') return null;
  const one = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!one) return null;
  const safe = redact(one).text;
  return safe.length > SUMMARY_MAX ? `${safe.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : safe;
}

/** Keeps the distil's short summary of a session (redacted) for the next report. Returns the stored text or null. */
export function saveSummary(p, sessionId, text, { now = Date.now() } = {}) {
  const f = scanFiles(p);
  if (!f.dir || typeof sessionId !== 'string' || !sessionId) return null;
  const clean = cleanSummary(text);
  if (!clean) return null;
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const all = quietJson(f.summaries) ?? {};
  all[sessionId] = { text: clean, at: iso(now) };
  writeJsonPrivate(f.summaries, all);
  return clean;
}

export function summaryOf(p, sessionId) {
  const f = scanFiles(p);
  if (!f.dir) return null;
  const s = quietJson(f.summaries)?.[sessionId]?.text;
  return typeof s === 'string' && s ? s : null;
}

// ------------------------------------------------------------------ listing

async function readHead(path, bytes = HEAD_BYTES) {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function dirents(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statQuiet(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** Every Claude Code transcript on disk: [{ id, path, mtimeMs, birthMs }]. */
async function claudeFiles(claudeHome) {
  const root = join(claudeHome, 'projects');
  const out = [];
  for (const d of await dirents(root)) {
    if (!d.isDirectory()) continue;
    for (const f of await dirents(join(root, d.name))) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const id = f.name.slice(0, -'.jsonl'.length);
      if (!UUID.test(id)) continue;
      const path = join(root, d.name, f.name);
      const st = await statQuiet(path);
      if (st) out.push({ id, path, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs || st.mtimeMs, archived: false });
    }
  }
  return out;
}

const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Every Codex rollout on disk (plain .jsonl), sessions/ and archived_sessions/: [{ id, path, mtimeMs, archived }]. */
async function codexFiles(codexHome) {
  const out = [];
  const walk = async (dir, depth, archived) => {
    for (const e of await dirents(dir)) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) await walk(path, depth - 1, archived);
        continue;
      }
      const m = ROLLOUT.exec(e.name);
      if (!m || !e.isFile()) continue;
      const st = await statQuiet(path);
      if (st) out.push({ id: m[1].toLowerCase(), path, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs || st.mtimeMs, archived });
    }
  };
  await walk(join(codexHome, 'sessions'), 3, false);
  await walk(join(codexHome, 'archived_sessions'), 3, true);
  return out;
}

/**
 * Claude Code's own marks of its sessions, <claude home>/sessions/<pid>.json: { live, dead }, the session
 * ids with a mark whose pid is alive, and those whose only marks have a dead pid.
 */
async function claudeMarks(claudeHome, alive) {
  const ids = new Set();
  const dead = new Set();
  const dir = join(claudeHome, 'sessions');
  for (const e of await dirents(dir)) {
    if (!e.isFile() || !/^\d+\.json$/.test(e.name)) continue;
    const text = await readHead(join(dir, e.name), 64 * 1024);
    let o = null;
    try {
      o = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof o?.sessionId !== 'string' || !Number.isInteger(o?.pid)) continue;
    (alive(o.pid) ? ids : dead).add(o.sessionId);
  }
  for (const id of ids) dead.delete(id);
  return { live: ids, dead };
}

// ------------------------------------------------------------------ one session's head

const firstPromptText = (o) => {
  const c = o?.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x?.type === 'text')?.text ?? null : null;
};

/** What the head of a Claude Code transcript says: { distil, cwd, startedAt, title }. */
function claudeHead(text) {
  const out = { distil: false, cwd: null, startedAt: null, title: null };
  let sawUser = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!out.cwd && typeof o?.cwd === 'string' && o.cwd) out.cwd = o.cwd;
    if (!out.startedAt && typeof o?.timestamp === 'string' && Number.isFinite(Date.parse(o.timestamp))) out.startedAt = o.timestamp;
    // the same test as the distil's own (lib/distil.js): the first user line is the distil prompt
    if (o?.type === 'user' && !sawUser) {
      sawUser = true;
      const t = firstPromptText(o);
      if (typeof t === 'string' && t.startsWith(DISTIL_PROMPT_START)) out.distil = true;
    }
    if (!out.title) {
      try {
        for (const e of parseTranscript(`${line}\n`).entries) {
          if (e.kind === 'prompt' && !e.meta && !e.sidechain) {
            const t = cleanTitle(e.text);
            if (t) {
              out.title = t;
              break;
            }
          }
        }
      } catch {
        // a line this reader does not know is not a prompt
      }
    }
    if (out.cwd && out.startedAt && out.title && sawUser) break;
  }
  return out;
}

/** What the head of a Codex rollout says: { person, distil, cwd, startedAt, title }. */
function codexHead(text) {
  const out = { person: false, distil: false, cwd: null, startedAt: null, title: null };
  const lines = text.split('\n');
  let head = null;
  try {
    head = headOf(JSON.parse(lines[0]));
  } catch {
    head = null;
  }
  if (!head?.personThread) return out;
  out.person = true;
  out.cwd = head.cwd;
  try {
    const ts = JSON.parse(lines[0])?.payload?.timestamp ?? JSON.parse(lines[0])?.timestamp;
    if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) out.startedAt = ts;
  } catch {
    // no time in the head
  }
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    let entries = [];
    try {
      entries = parseRollout(`${line}\n`, { head }).entries;
    } catch {
      continue;
    }
    const prompt = entries.find((e) => e.kind === 'prompt' && !e.meta);
    if (!prompt) continue;
    if (stripCodexInjected(String(prompt.text)).startsWith(DISTIL_PROMPT_START)) out.distil = true;
    out.title = cleanTitle(prompt.text);
    break;
  }
  return out;
}

// ------------------------------------------------------------------ the tick

const fingerprint = (e) => createHash('sha256').update(JSON.stringify([
  e.state, e.can_take_tasks, e.title ?? null, e.project ?? null, e.summary ?? null, e.account ?? null,
  e.state === 'open' ? Math.floor(Date.parse(e.last_active_at) / SCAN_EVERY_MS) : e.last_active_at,
])).digest('hex').slice(0, 24);

const hasScope = (c, s) => Array.isArray(c?.scopes) && c.scopes.includes(s);

/**
 * One scan of this connection's harness home. `report(sessions)` sends one sessions_report and
 * returns { ok }. Returns { ran, reported, backlog } (ran: false when another process scans now,
 * or there is nothing to scan for).
 */
export async function scanTick({
  paths: p, harness, credentials, report, env = process.env, home = homedir(), now = Date.now, alive = defaultAlive, batch = SCAN_BATCH,
  claudeHome = claudeHomeOf(env), codexHome = codexHomeOf(env), bridgeRecord = () => null, pollerOf = () => null,
} = {}) {
  const f = scanFiles(p);
  if (!f.dir || !p.connection || (harness !== 'claude-code' && harness !== 'codex')) return { ran: false, reported: 0, backlog: 0 };
  if (!hasScope(credentials, 'sessions:light') && !hasScope(credentials, 'sessions:full')) return { ran: false, reported: 0, backlog: 0 };
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  let held;
  try {
    held = acquire(f.lock, { tries: 1, waitMs: 0, alive });
  } catch {
    return { ran: false, reported: 0, backlog: 0 };
  }
  try {
    const state = quietJson(f.state) ?? {};
    // { [id]: { fp, at } }: what was last sent for each session, and when
    const sent = state.sent && typeof state.sent === 'object' ? state.sent : {};
    const heads = state.heads && typeof state.heads === 'object' ? state.heads : {};
    const full = hasScope(credentials, 'sessions:full');
    const t = now();
    const account = accountOf(harness, env, home);
    // Where an unpinned session of this harness account goes: the env of this process says nothing about another session.
    const envNoPin = { ...env };
    delete envNoPin[NODE_ENV];
    const files = harness === 'codex' ? await codexFiles(codexHome) : await claudeFiles(claudeHome);
    const { live, dead } = harness === 'claude-code' ? await claudeMarks(claudeHome, alive) : { live: new Set(), dead: new Set() };
    const summaries = full ? quietJson(f.summaries) ?? {} : {};

    const candidates = [];
    for (const file of files) {
      if (sessionConnection(p.root, { sessionId: file.id, env: envNoPin, account }) !== p.connection) continue;
      let h = heads[file.id];
      if (!h || h.path !== file.path) {
        const text = await readHead(file.path);
        if (text === null) continue;
        const read = harness === 'codex' ? codexHead(text) : { person: true, ...claudeHead(text) };
        h = { path: file.path, skip: !read.person || read.distil, cwd: read.cwd, startedAt: read.startedAt, title: read.title };
        // a head without a prompt yet is read again next time
        if (h.skip || h.title) heads[file.id] = h;
      }
      if (h.skip) continue;
      const rec = bridgeRecord(file.id);
      const hooked = rec && rec.state === 'open' && t - Date.parse(rec.lastActiveAt) <= IDLE_LIMIT_MS;
      // the poller record: { pid } of the process waiting for a task, pid null while paused for the person's turn
      const poller = pollerOf(file.id);
      const pollerRuns = Number.isInteger(poller?.pid) && alive(poller.pid);
      const running = live.has(file.id) || (!dead.has(file.id) && t - file.mtimeMs <= OPEN_RECENT_MS);
      const open = !file.archived && (running || (hooked && pollerRuns && !dead.has(file.id)));
      const entry = { id: file.id, harness };
      const title = h.title ?? (typeof rec?.title === 'string' ? rec.title : null);
      if (title) entry.title = title;
      const project = projectOf(h.cwd ?? rec?.cwd ?? null);
      if (project) entry.project = project;
      if (account) entry.account = account;
      const started = Date.parse(h.startedAt ?? rec?.startedAt ?? '');
      entry.started_at = iso(Number.isFinite(started) ? Math.min(started, file.mtimeMs) : Math.min(file.birthMs, file.mtimeMs));
      entry.last_active_at = iso(Math.max(file.mtimeMs, Date.parse(rec?.lastActiveAt ?? '') || 0));
      entry.state = open ? 'open' : 'closed';
      entry.can_take_tasks = Boolean(open && hooked && (pollerRuns || (poller && poller.pid === null && running)));
      const summary = summaries[file.id]?.text;
      if (typeof summary === 'string' && summary) entry.summary = summary;
      const fp = fingerprint(entry);
      const was = sent[file.id];
      const stale = open && t - (Number(was?.at) || 0) >= REFRESH_OPEN_MS;
      if (was?.fp !== fp || stale) candidates.push({ entry, fp });
    }
    candidates.sort((a, b) => (a.entry.state === b.entry.state ? 0 : a.entry.state === 'open' ? -1 : 1)
      || Date.parse(b.entry.last_active_at) - Date.parse(a.entry.last_active_at));
    const now1 = candidates.slice(0, Math.max(1, batch));
    let reported = 0;
    if (now1.length) {
      const out = await report(now1.map((c) => c.entry));
      if (out?.ok) {
        for (const c of now1) sent[c.entry.id] = { fp: c.fp, at: t };
        reported = now1.length;
      }
    }
    // forget what is gone from disk, so the state does not grow without end
    const onDisk = new Set(files.map((x) => x.id));
    for (const id of Object.keys(sent)) if (!onDisk.has(id)) delete sent[id];
    for (const id of Object.keys(heads)) if (!onDisk.has(id)) delete heads[id];
    const backlog = candidates.length - reported;
    if (held.stillHeld()) writeJsonPrivate(f.state, { version: 1, sent, heads, lastTickAt: iso(t), backlog });
    return { ran: true, reported, backlog };
  } finally {
    held.release();
  }
}

/** Whether a scan is due: the last tick left a backlog, or SCAN_EVERY_MS passed. */
export function scanDue(p, { now = Date.now() } = {}) {
  const f = scanFiles(p);
  if (!f.dir || !existsSync(f.dir)) return true;
  const s = quietJson(f.state);
  if (!s?.lastTickAt) return true;
  return s.backlog > 0 || now - Date.parse(s.lastTickAt) >= SCAN_EVERY_MS;
}

