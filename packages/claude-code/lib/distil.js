// The background distil (Claude Code): the person's local sessions become short work facts on
// their colleague's node, each exactly once. Oscar 2026-10-21 (Todo answers, relayed in #4): the
// run is «Headless claude -p in the background», and the hooks send «essence only».
//
// Two steps, never mixed:
//   distil   a detached `claude -p` reads the noted transcript ranges with read-only tools. Its
//            `remember` calls go to the plugin's own MCP server in distil mode (lib/mcp-proxy.js),
//            which redacts each call and appends it to the run's OUTBOX. Nothing reaches the node
//            here. The run ends with `distil_done`. A run without a valid `done` record sent
//            nothing, so its transcripts simply go back to pending.
//   deliver  the watchdog sends the outbox, one record per `remember`, each with its own
//            idempotency_key, and appends the node's acknowledgement to the run's ACKS file.
//            A retry sends only the records without an ack, with the same keys, from the same
//            outbox; claude never runs again for them. Only every record acked is a success.
//
// Files under <home>/state (all owner-only):
//   distil.json                the state: pending ranges, what is distilled, the run, the outbox
//   distil/distil.lock         lib/lock.js; never taken over from a live holder
//   distil/notes/<h>.json      one per noted transcript, written lock-free by the hooks, folded
//                              into pending by whoever holds the lock
//   distil/runs/<run>.*        plan, outbox, acks (lib/ledger.js: checksummed lines), log
//
// Bounds: pending plus the run in flight hold at most MAX_PENDING transcripts; past that, notes
// wait on disk, folded oldest first as room frees. Past MAX_NOTE_FILES a note is dropped with a
// count, and SessionStart says so. A failed run's transcripts go back by their noted time.

import { spawn as defaultSpawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { withLock, acquire, isAlive as defaultAlive } from './lock.js';
import { appendRecord, readRecords } from './ledger.js';
import { loadCredentials, saveCredentials, readJson, writeJsonPrivate } from './home.js';
import { callTool } from './post.js';
import { refreshTokens } from './oauth.js';
import { redactValue } from './redact.js';

export const DISTIL_ENV = 'WYBE_CONNECT_DISTIL';
export const ONGOING_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const BACKLOG_INTERVAL_MS = 30 * 60 * 1000;
export const BACKOFF_MS = 30 * 60 * 1000;
export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const RUN_DEAD_AFTER_MS = 45 * 60 * 1000; // the watchdog ends claude at 30 min; past 45 its pid is someone else's
export const STARTING_GRACE_MS = 2 * 60 * 1000;
export const DELIVERY_TIMEOUT_MS = 60 * 1000;
export const MAX_PENDING = 2000;
export const MAX_NOTE_FILES = 20000;
export const MAX_RUN_TRANSCRIPTS = 40;
export const MAX_RUN_PATH_CHARS = 12000;
export const MAX_PATH_CHARS = 1024;
export const IMPORT_DAYS = 30;
export const KEEP_DISTILLED_MS = 90 * 24 * 60 * 60 * 1000;
export const KEEP_LOGS_MS = 14 * 24 * 60 * 60 * 1000;

const PLUGIN_ROOT = join(import.meta.dirname, '..');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const iso = (ms) => new Date(ms).toISOString();
const ms = (at) => (at ? Date.parse(at) : NaN);
const sleep = (n) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);

export function distilPaths(p) {
  const dir = join(p.state, 'distil');
  const runs = join(dir, 'runs');
  return {
    dir,
    runs,
    state: join(p.state, 'distil.json'),
    lock: join(dir, 'distil.lock'),
    deliverLock: join(dir, 'deliver.lock'),
    notes: join(dir, 'notes'),
    dropped: join(dir, 'dropped.log'),
    plan: (runId) => join(runs, `${runId}.plan.json`),
    outbox: (runId) => join(runs, `${runId}.outbox`),
    acks: (runId) => join(runs, `${runId}.acks`),
    log: (runId) => join(runs, `${runId}.log`),
    torn: (runId) => join(runs, `${runId}.torn`), // outbox lines that no longer check out, set aside
  };
}

const EMPTY = Object.freeze({
  version: 2,
  pending: [], // [{ path, sessionId, cwd, notedAt }], oldest first
  distilled: {}, // { [path]: { line, at } }: the next run of that transcript starts after `line`
  running: null, // { runId, mode, importOf, pid, startedAt, transcripts: [{ path, sessionId, cwd, notedAt, fromLine, toLine }] }
  outbox: null, // { runId, mode, importOf, doneAt }: distilled, not yet all acknowledged
  importRequest: null,
  importHandled: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null, // { class, message, at }
  problemShown: null, // the lastError class SessionStart already told
  dropped: null, // { count, firstAt, lastAt }
  droppedShown: 0,
  // Records set aside so they never hold the pipeline: refused for good by the node (a tool
  // error), or outbox lines damaged after distil_done. Counted here, told once at SessionStart.
  setAside: { refused: 0, torn: 0 },
  setAsideShown: { refused: 0, torn: 0 },
});

export function loadState(p) {
  const s = readJson(distilPaths(p).state);
  return { ...structuredClone(EMPTY), ...(s && s.version === 2 ? s : {}) };
}

/** Writes the state only while the lock is still ours (the fence), retrying a rename a reader blocks (Windows). */
function saveState(p, s, stillHeld) {
  if (!stillHeld()) throw Object.assign(new Error('lost the distil lock; not writing'), { code: 'ELOCKLOST' });
  for (let i = 0; ; i++) {
    try {
      writeJsonPrivate(distilPaths(p).state, s);
      return;
    } catch (err) {
      if (i >= 20 || !(err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES')) throw err;
      sleep(25);
    }
  }
}

function locked(p, fn, opts = { tries: 40, waitMs: 50 }) {
  return withLock(distilPaths(p).lock, ({ stillHeld }) => {
    const s = loadState(p);
    return fn(s, (next = s) => saveState(p, next, stillHeld));
  }, opts);
}

export function safeTranscriptPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_CHARS) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  if (!path.endsWith('.jsonl')) return null;
  if (!win32.isAbsolute(path) && !posix.isAbsolute(path)) return null;
  return path;
}

const hasRemember = (p) => {
  try {
    return loadCredentials(p)?.scopes?.includes('remember') === true;
  } catch {
    return false;
  }
};

const noteName = (path) => `${createHash('sha256').update(path).digest('hex').slice(0, 32)}.json`;

/**
 * Stop / SessionEnd / PreCompact: remembers that a transcript has new work. Lock-free: one file
 * per transcript, replaced atomically, so a slow lock holder can never erase it (QA R4-7).
 * Returns { noted: true }, { dropped: true } (past the cap, counted) or null (nothing to note).
 */
export function noteSession(p, { transcriptPath, sessionId = null, cwd = null, now = Date.now(), maxNoteFiles = MAX_NOTE_FILES }) {
  const path = safeTranscriptPath(transcriptPath);
  if (!path || !hasRemember(p)) return null;
  const dp = distilPaths(p);
  mkdirSync(dp.notes, { recursive: true, mode: 0o700 });
  const file = join(dp.notes, noteName(path));
  let notedAt = iso(now);
  if (existsSync(file)) {
    try {
      notedAt = JSON.parse(readFileSync(file, 'utf8')).notedAt ?? notedAt; // a waiting session keeps its place
    } catch {
      // being replaced right now: ours is as good
    }
  } else if (readdirSync(dp.notes).filter((f) => f.endsWith('.json')).length >= maxNoteFiles) {
    appendRecord(dp.dropped, { at: iso(now) });
    return { dropped: true };
  }
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, path, sessionId: typeof sessionId === 'string' ? sessionId : null, cwd: typeof cwd === 'string' ? cwd.slice(0, MAX_PATH_CHARS) : null, notedAt }), { mode: 0o600 });
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      break;
    } catch (err) {
      if (i >= 20 || !(err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES')) {
        try { unlinkSync(tmp); } catch { /* best effort */ }
        throw err;
      }
      sleep(25);
    }
  }
  return { noted: true };
}

function readNotes(dp) {
  if (!existsSync(dp.notes)) return [];
  const out = [];
  for (const f of readdirSync(dp.notes)) {
    if (!f.endsWith('.json')) continue;
    const file = join(dp.notes, f);
    try {
      const n = JSON.parse(readFileSync(file, 'utf8'));
      if (safeTranscriptPath(n?.path)) out.push({ file, path: n.path, sessionId: n.sessionId ?? null, cwd: n.cwd ?? null, notedAt: n.notedAt ?? iso(statSync(file).mtimeMs) });
    } catch {
      // vanished or replaced between list and read: the next fold sees it
    }
  }
  return out.sort((a, b) => ms(a.notedAt) - ms(b.notedAt));
}

const inFlight = (s) => (s.running?.transcripts ?? []).length;
const byNoted = (a, b) => ms(a.notedAt) - ms(b.notedAt);

/** Moves notes into pending while there is room. Returns the note files to delete after the state is written. */
function foldNotes(p, s) {
  const dp = distilPaths(p);
  const folded = [];
  const index = new Map(s.pending.map((x) => [x.path, x]));
  for (const n of readNotes(dp)) {
    const have = index.get(n.path);
    if (have) {
      have.sessionId = n.sessionId ?? have.sessionId;
      have.cwd = n.cwd ?? have.cwd;
      folded.push(n.file);
      continue;
    }
    if (s.pending.length + inFlight(s) >= MAX_PENDING) continue; // waits on disk: never dropped for lack of room
    const entry = { path: n.path, sessionId: n.sessionId, cwd: n.cwd, notedAt: n.notedAt };
    s.pending.push(entry);
    index.set(n.path, entry);
    folded.push(n.file);
  }
  s.pending.sort(byNoted);
  return [...folded, ...foldDropped(p, s)];
}

/** Dropped notes: counted into the state once, then their log goes. Returns the file to delete. */
function foldDropped(p, s) {
  const dp = distilPaths(p);
  if (existsSync(dp.dropped)) {
    try {
      renameSync(dp.dropped, `${dp.dropped}.${process.pid}-${randomBytes(3).toString('hex')}.fold`);
    } catch {
      // a hook is appending right now: next fold
    }
  }
  // Every set-aside log, also one an earlier holder moved but could not save: none is lost.
  const folded = existsSync(dp.dir) ? readdirSync(dp.dir).filter((f) => f.startsWith('dropped.log.') && f.endsWith('.fold')).map((f) => join(dp.dir, f)) : [];
  for (const file of folded) {
    const { records } = readRecords(file);
    if (!records.length) continue;
    const ats = records.map((r) => r.at).filter(Boolean).sort();
    s.dropped = { count: (s.dropped?.count ?? 0) + records.length, firstAt: s.dropped?.firstAt ?? ats[0] ?? null, lastAt: ats[ats.length - 1] ?? s.dropped?.lastAt ?? null };
  }
  return folded;
}

const unlinkAll = (files) => { for (const f of files) { try { unlinkSync(f); } catch { /* gone already, or a hook replaced it: still pending */ } } };

/** Every transcript still waiting to be distilled: the run in flight, folded entries, and notes waiting on disk. */
export function pendingView(p) {
  const s = loadState(p);
  const seen = new Map([...(s.running?.transcripts ?? []), ...s.pending].map((x) => [x.path, x]));
  for (const n of readNotes(distilPaths(p))) if (!seen.has(n.path)) seen.set(n.path, n);
  return [...seen.values()];
}

function returnToPending(s, transcripts) {
  const index = new Map(s.pending.map((x) => [x.path, x]));
  for (const t of transcripts) {
    const have = index.get(t.path);
    if (have) {
      if (ms(t.notedAt) < ms(have.notedAt)) have.notedAt = t.notedAt;
      continue;
    }
    const entry = { path: t.path, sessionId: t.sessionId ?? null, cwd: t.cwd ?? null, notedAt: t.notedAt };
    s.pending.push(entry);
    index.set(t.path, entry);
  }
  s.pending.sort(byNoted);
}

function bind(s, run, now) {
  for (const t of run.transcripts) s.distilled[t.path] = { line: t.toLine, at: iso(now) };
  for (const [path, d] of Object.entries(s.distilled)) if (now - ms(d.at) > KEEP_DISTILLED_MS) delete s.distilled[path];
  s.outbox = { runId: run.runId, mode: run.mode, importOf: run.importOf ?? null, doneAt: iso(now) };
}

function fail(s, cls, message, now) {
  s.lastFailureAt = iso(now);
  s.lastRunAt = iso(now);
  s.lastError = { class: cls, message: String(message).slice(0, 300), at: iso(now) };
}

function removeRunFiles(p, runId) {
  const dp = distilPaths(p);
  unlinkAll([dp.plan(runId), dp.outbox(runId), dp.acks(runId)]);
}

/** A run whose watchdog is gone: a valid outbox is kept for delivery, anything else goes back. */
function reconcile(p, s, now, alive) {
  const r = s.running;
  if (!r) return;
  const age = now - ms(r.startedAt);
  const live = r.pid ? alive(r.pid) && age < RUN_DEAD_AFTER_MS : age < STARTING_GRACE_MS;
  if (live) return;
  s.running = null;
  if (r.mode === 'deliver') return; // the outbox stays; the next tick delivers it
  if (outboxVerdict(p, r).ok) {
    bind(s, r, now);
    return;
  }
  returnToPending(s, r.transcripts);
  removeRunFiles(p, r.runId);
  fail(s, 'distil-failed', 'the background run stopped before it finished', now);
}

function countLines(path) {
  try {
    const buf = readFileSync(path);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n += 1;
    return n;
  } catch {
    return null;
  }
}

/** The oldest pending ranges that have new lines, within the run's caps. Pending entries with nothing new, or whose file is gone, leave pending. */
function pick(s) {
  const take = [];
  let chars = 0;
  const keep = [];
  for (const x of s.pending) {
    if (take.length >= MAX_RUN_TRANSCRIPTS || chars + x.path.length > MAX_RUN_PATH_CHARS) {
      keep.push(x);
      continue;
    }
    const toLine = countLines(x.path);
    const fromLine = s.distilled[x.path]?.line ?? 0;
    if (toLine === null || toLine <= fromLine) continue; // deleted by Claude Code, or nothing new
    take.push({ ...x, fromLine, toLine });
    chars += x.path.length;
  }
  s.pending = keep;
  return take;
}

/** Records the node's import request (from a tool answer). Returns whether it is new. */
export function requestImport(p, requestedAt) {
  if (typeof requestedAt !== 'string' || !ISO.test(requestedAt) || !Number.isFinite(Date.parse(requestedAt))) return false;
  try {
    return locked(p, (s, save) => {
      if (requestedAt === s.importHandled || requestedAt === s.importRequest) return false;
      s.importRequest = requestedAt;
      save();
      return true;
    });
  } catch (err) {
    if (err?.code === 'ELOCKBUSY') return false;
    throw err;
  }
}

/**
 * One scheduler tick (a hook, or the MCP server on an import request). Folds notes, settles a
 * dead run, and starts the detached watchdog when there is work: an undelivered outbox first, then
 * an import, then an ongoing run. Returns the plan it started, or null.
 */
export function maybeRun({ paths: p, env = process.env, now = Date.now(), alive = defaultAlive, spawnImpl = defaultSpawn, watchdog = join(PLUGIN_ROOT, 'bin', 'distil-run.js') } = {}) {
  if (env[DISTIL_ENV]) return null; // a distil run's own hooks and server never start another
  if (!hasRemember(p)) return null;
  const dp = distilPaths(p);
  let folded = [];
  let plan;
  try {
    plan = locked(p, (s, save) => {
      folded = foldNotes(p, s);
      reconcile(p, s, now, alive);
      const decided = decide(s, now);
      if (decided) {
        s.running = { ...decided, pid: null, startedAt: iso(now) };
        if (decided.mode === 'import') s.importRequest = null;
      }
      save();
      return decided;
    });
  } catch (err) {
    if (err?.code === 'ELOCKBUSY') return null;
    throw err;
  }
  unlinkAll(folded);
  if (!plan) return null;
  const planFile = dp.plan(plan.runId);
  writeJsonPrivate(planFile, { ...plan, root: p.root });
  mkdirSync(dp.runs, { recursive: true, mode: 0o700 });
  let pid = null;
  try {
    const child = spawnImpl(process.execPath, [watchdog, planFile], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, WYBE_CONNECT_HOME: p.root } });
    child.on?.('error', () => {});
    child.unref?.();
    pid = child.pid ?? null;
  } catch {
    pid = null; // the starting grace runs out and the next tick gives the transcripts back
  }
  if (pid) {
    try {
      locked(p, (s, save) => {
        if (s.running?.runId === plan.runId && !s.running.pid) {
          s.running.pid = pid;
          save();
        }
      });
    } catch {
      // the watchdog records itself too
    }
  }
  return { ...plan, planFile };
}

function decide(s, now) {
  if (s.running) return null;
  const backoff = Number.isFinite(ms(s.lastFailureAt)) && now - ms(s.lastFailureAt) < BACKOFF_MS;
  if (backoff) return null;
  // 128 random bits: the node keeps a key once per PERSON across all their assistants and machines
  // (wybe-node#844), and every key derives from the run id, so two runs must never share one.
  const runId = `${iso(now).replace(/[:.]/g, '-')}-${randomBytes(16).toString('hex')}`;
  if (s.outbox) return { runId: s.outbox.runId, mode: 'deliver', importOf: s.outbox.importOf, transcripts: [] };
  if (s.importRequest && s.importRequest !== s.importHandled) {
    return { runId, mode: 'import', importOf: s.importRequest, transcripts: pick(s) };
  }
  if (!s.pending.length) return null;
  const since = now - ms(s.lastSuccessAt);
  const due = !Number.isFinite(since) || since >= ONGOING_INTERVAL_MS || (s.pending.length > MAX_RUN_TRANSCRIPTS && since >= BACKLOG_INTERVAL_MS);
  if (!due) return null;
  const transcripts = pick(s);
  return transcripts.length ? { runId, mode: 'ongoing', importOf: null, transcripts } : null;
}

// ------------------------------------------------------------------ the outbox (written by the run's MCP server)

// One key per outbox record. A record never changes once written, and a redone distil is a new run
// with new keys, so a key is never reused for new content (the node would replay the old answer).
const keyOf = (runId, seq) => `wc1-${createHash('sha256').update(`${runId}:${seq}`).digest('hex')}`;

function outboxRecords(p, runId) {
  return readRecords(distilPaths(p).outbox(runId));
}

/** The run's `remember`: redacted, then appended. Returns { seq } or { error }. */
export function spoolRemember(p, runId, args) {
  const { records } = outboxRecords(p, runId);
  if (records.some((r) => r.kind === 'done')) return { error: 'this distil run already called distil_done' };
  const seq = records.filter((r) => r.kind === 'remember').reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  const { value } = redactValue(args);
  appendRecord(distilPaths(p).outbox(runId), { kind: 'remember', seq, key: keyOf(runId, seq), args: value });
  return { seq };
}

/** The run's `distil_done`: closes the outbox with the number of calls it holds. */
export function spoolDone(p, runId) {
  const { records } = outboxRecords(p, runId);
  if (records.some((r) => r.kind === 'done')) return { items: records.filter((r) => r.kind === 'remember').length, again: true };
  const items = records.filter((r) => r.kind === 'remember').length;
  appendRecord(distilPaths(p).outbox(runId), { kind: 'done', items });
  return { items };
}

/** Whether a run's outbox is whole: one `done`, its count matching the records, no torn line, and for an import an import_of. */
export function outboxVerdict(p, run) {
  const { records, torn } = outboxRecords(p, run.runId);
  const items = records.filter((r) => r.kind === 'remember');
  const done = records.filter((r) => r.kind === 'done');
  if (torn) return { ok: false, reason: `the outbox has ${torn} unreadable line(s)` };
  if (done.length !== 1) return { ok: false, reason: 'the run did not finish (no distil_done)' };
  if (done[0].items !== items.length) return { ok: false, reason: `the outbox holds ${items.length} call(s), distil_done counted ${done[0].items}` };
  if (run.mode === 'import' && !items.some((r) => r.args?.import_of === run.importOf)) return { ok: false, reason: 'the import run sent no import_of' };
  return { ok: true, items };
}

// ------------------------------------------------------------------ delivery

const parseAnswer = (result) => {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = Array.isArray(result?.content) ? result.content.find((c) => c?.type === 'text')?.text : undefined;
  try {
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/**
 * Sends every record of the outbox the node has not settled, in order (the record carrying
 * import_of last), and appends each answer to the acks file. An ack is a JSON-RPC result that is
 * not an error, says ok: true and has a numeric `stored`. A tool error is the node refusing that
 * record for good: it is recorded as refused, never re-sent, and delivery goes on. An outbox line
 * that no longer checks out (damaged after distil_done, when the run was already judged whole) is
 * copied aside to <run>.torn and the intact records are delivered. Stops at the first other
 * failure. Returns { ok, class?, message?, importDone, sent, refused, torn }.
 */
export async function deliver(p, run, { fetchImpl = globalThis.fetch, timeoutMs = DELIVERY_TIMEOUT_MS, now = Date.now } = {}) {
  const dp = distilPaths(p);
  let held;
  try {
    held = acquire(dp.deliverLock, { tries: 1 });
  } catch (err) {
    if (err?.code === 'ELOCKBUSY') return { ok: false, class: 'busy', message: 'another delivery is running', importDone: false, sent: 0 };
    throw err;
  }
  try {
    const { records, torn, tornLines } = readRecords(dp.outbox(run.runId), { keepTorn: true });
    const items = records.filter((r) => r.kind === 'remember');
    // An intact outbox without distil_done was never judged whole: nothing of it is sent.
    if (!torn && records.filter((r) => r.kind === 'done').length !== 1) return { ok: false, class: 'distil-failed', message: 'the run did not finish (no distil_done)', importDone: false, sent: 0 };
    if (torn) writeFileSync(dp.torn(run.runId), `${tornLines.join('\n')}\n`, { mode: 0o600 });
    const acks = readRecords(dp.acks(run.runId)).records;
    const acked = new Set(acks.map((a) => a.seq));
    let importDone = acks.some((a) => a.importDone === true);
    const settled = () => {
      const all = readRecords(dp.acks(run.runId)).records;
      return { refused: new Set(all.filter((a) => a.refused === true).map((a) => a.seq)).size, torn };
    };
    const order = [...items].sort((a, b) => (a.args?.import_of ? 1 : 0) - (b.args?.import_of ? 1 : 0) || a.seq - b.seq);
    let c;
    try {
      c = loadCredentials(p);
    } catch {
      c = null;
    }
    let sent = 0;
    for (const r of order) {
      if (acked.has(r.seq)) continue;
      if (!c) return { ok: false, class: 'signed-out', message: 'not connected to a Wybe AI colleague', importDone, sent };
      const args = { ...r.args, idempotency_key: r.key };
      let out = await callTool({ endpoint: c.mcpEndpoint, accessToken: c.accessToken, name: 'remember', args, fetchImpl, timeoutMs });
      if (!out.ok && out.kind === 'auth' && c.refreshToken) {
        const next = await refreshTokens({ tokenEndpoint: c.tokenEndpoint, clientId: c.clientId, refreshToken: c.refreshToken, resource: c.resource ?? c.mcpEndpoint, requestedScopes: c.scopes, fetchImpl, now: now() });
        if (next) {
          c = { ...c, ...next };
          saveCredentials(c, p);
          out = await callTool({ endpoint: c.mcpEndpoint, accessToken: c.accessToken, name: 'remember', args, fetchImpl, timeoutMs });
        }
      }
      if (!out.ok && out.toolError) {
        appendRecord(dp.acks(run.runId), { seq: r.seq, key: r.key, refused: true, message: String(out.message).slice(0, 200), at: iso(now()) });
        sent += 1;
        continue;
      }
      if (!out.ok) return { ok: false, class: out.kind === 'auth' ? 'signed-out' : 'node-unreachable', message: out.message, importDone, sent };
      const answer = parseAnswer(out.result);
      if (answer?.ok !== true || typeof answer.stored !== 'number') return { ok: false, class: 'node-refused', message: 'the colleague answered without confirming it stored the facts', importDone, sent };
      const done = answer.import_done === true;
      appendRecord(dp.acks(run.runId), { seq: r.seq, key: r.key, stored: answer.stored, importDone: done, at: iso(now()) });
      importDone = importDone || done;
      sent += 1;
    }
    return { ok: true, importDone, sent, ...settled() };
  } finally {
    held.release();
  }
}

// ------------------------------------------------------------------ the watchdog (bin/distil-run.js)

/** How to start claude without a shell: an override, claude(.exe) on PATH, or the npm shim's cli.js under Node. */
export function resolveClaude(env = process.env, platform = process.platform) {
  const override = env.WYBE_CONNECT_CLAUDE_BIN;
  if (override) return /\.(?:m?js|cjs)$/.test(override) ? { cmd: process.execPath, pre: [override] } : { cmd: override, pre: [] };
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  dirs.push(join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'));
  const win = platform === 'win32';
  for (const d of dirs) {
    const exe = join(d, win ? 'claude.exe' : 'claude');
    if (existsSync(exe)) return { cmd: exe, pre: [] };
    if (win && existsSync(join(d, 'claude.cmd'))) {
      const cli = join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (existsSync(cli)) return { cmd: process.execPath, pre: [cli] };
    }
  }
  return null;
}

export function buildPrompt(plan) {
  const lines = [
    'wybe-connect distil run (started in the background by the wybe-connect plugin, not by a person).',
    `mode: ${plan.mode}`,
  ];
  if (plan.mode === 'import') lines.push(`import_of: ${plan.importOf}`);
  lines.push('', 'Read these transcript ranges with the Read tool (offset = the first line, limit = the number of lines):');
  for (const t of plan.transcripts) lines.push(`- ${t.path} lines ${t.fromLine + 1}-${t.toLine}`);
  if (!plan.transcripts.length) lines.push('- (none)');
  if (plan.mode === 'import') {
    lines.push(
      '',
      `This is the import the person asked for in Wybe. Also read ~/.claude/CLAUDE.md, the CLAUDE.md of the projects in those transcripts, the auto memory under ~/.claude/projects/*/memory/, and the transcripts from the last ${IMPORT_DAYS} days under ~/.claude/projects/. Skip any transcript whose first user message starts with "wybe-connect distil run".`,
    );
  }
  lines.push(
    '',
    'Then:',
    '1. Pick at most 40 durable facts about the person\'s WORK: projects, decisions and why, preferences, ways of working, tools, ideas. One short, self-contained statement per item, at most 400 characters. Work only: never secrets, credentials, code, file contents, anything personal, or anything about other people.',
    '2. If pending_questions has open questions this material clearly answers, add the answer as an item and pass answers: [<question id>].',
    '3. Send the items with the wybe server\'s remember tool, at most 50 items per call.' + (plan.mode === 'import' ? ` Pass import_of: ${plan.importOf} on the LAST remember call, and send at least one item.` : ''),
    '4. Finally call distil_done exactly once. If nothing is durable, send nothing and call distil_done.',
  );
  return lines.join('\n');
}

export function claudeArgs(plan, { root, pluginRoot = PLUGIN_ROOT }) {
  const mcp = { mcpServers: { wybe: { command: process.execPath, args: [join(pluginRoot, 'bin', 'mcp-proxy.js')], env: { [DISTIL_ENV]: plan.runId, WYBE_CONNECT_HOME: root } } } };
  return [
    '-p', buildPrompt(plan),
    '--tools', 'Read,Glob,Grep',
    '--allowedTools', 'mcp__wybe__remember,mcp__wybe__distil_done,mcp__wybe__pending_questions',
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--permission-mode', 'dontAsk',
    '--max-turns', '40',
  ];
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}

function runClaude(plan, { root, resolve, spawnImpl, runTimeoutMs, logFile }) {
  const how = resolve();
  if (!how) return Promise.resolve({ code: null, error: 'claude-missing' });
  return new Promise((done) => {
    let fd = null;
    try {
      fd = openSync(logFile, 'a', 0o600);
    } catch {
      fd = null;
    }
    const io = fd === null ? 'ignore' : fd;
    let child;
    try {
      child = spawnImpl(how.cmd, [...how.pre, ...claudeArgs(plan, { root })], { stdio: ['ignore', io, io], windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, [DISTIL_ENV]: plan.runId, WYBE_CONNECT_HOME: root } });
    } catch (err) {
      if (fd !== null) closeSync(fd);
      done({ code: null, error: `could not start claude: ${err?.code ?? err}` });
      return;
    }
    const timer = setTimeout(() => killTree(child.pid), runTimeoutMs);
    const end = (code, error = null) => {
      clearTimeout(timer);
      if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
      done({ code, error });
    };
    child.on('error', (err) => end(null, `could not start claude: ${err?.code ?? err}`));
    child.on('exit', (code) => end(code));
  });
}

function pruneLogs(p, now) {
  const dp = distilPaths(p);
  if (!existsSync(dp.runs)) return;
  for (const f of readdirSync(dp.runs)) {
    if (!f.endsWith('.log') && !f.endsWith('.torn')) continue;
    try {
      if (now - statSync(join(dp.runs, f)).mtimeMs > KEEP_LOGS_MS) unlinkSync(join(dp.runs, f));
    } catch {
      // best effort
    }
  }
}

/**
 * The detached watchdog for one plan: runs the distil (unless the plan only delivers), then
 * delivers. Every state change is fenced by the runId, so a watchdog the scheduler already gave
 * up on changes nothing. Returns { ok, class?, message?, outcome? }.
 */
export async function runWatchdog(planFile, { paths: p, now = Date.now, resolve = () => resolveClaude(), spawnImpl = defaultSpawn, fetchImpl = globalThis.fetch, timeoutMs = DELIVERY_TIMEOUT_MS, runTimeoutMs = RUN_TIMEOUT_MS } = {}) {
  const plan = readJson(planFile);
  if (!plan?.runId) return { ok: false, outcome: 'no-plan' };
  const mine = (s) => s.running?.runId === plan.runId;
  const claimed = locked(p, (s, save) => {
    if (!mine(s)) return false;
    s.running.pid = process.pid;
    save();
    return true;
  });
  if (!claimed) return { ok: false, outcome: 'superseded' };
  pruneLogs(p, now());

  if (plan.mode !== 'deliver') {
    const exit = await runClaude(plan, { root: p.root, resolve, spawnImpl, runTimeoutMs, logFile: distilPaths(p).log(plan.runId) });
    const verdict = outboxVerdict(p, plan);
    const settled = locked(p, (s, save) => {
      // Given up on: what this run wrote is dropped, unless the scheduler already kept its outbox.
      if (!mine(s)) return { ok: false, outcome: 'superseded', orphan: s.outbox?.runId !== plan.runId };
      if (verdict.ok) {
        bind(s, s.running, now());
        s.running = { ...s.running, mode: 'deliver', transcripts: [] };
        save();
        return null;
      }
      const cls = exit.error === 'claude-missing' ? 'claude-missing' : 'distil-failed';
      const why = exit.error === 'claude-missing' ? 'claude was not found on this machine' : `${verdict.reason}${exit.code ? ` (claude exited ${exit.code})` : ''}`;
      returnToPending(s, s.running.transcripts);
      s.running = null;
      fail(s, cls, why, now());
      save();
      return { ok: false, class: cls, message: why };
    });
    if (settled) {
      if (!settled.outcome || settled.orphan) removeRunFiles(p, plan.runId);
      delete settled.orphan;
      return settled;
    }
  }

  const d = await deliver(p, plan, { fetchImpl, timeoutMs, now });
  const result = locked(p, (s, save) => {
    if (mine(s)) s.running = null;
    if (s.outbox?.runId !== plan.runId) {
      save();
      return { ok: false, outcome: 'superseded' };
    }
    if (d.ok) {
      // An import the node did not confirm is still handled: its facts are stored, and running it
      // again would only send them twice. The person is told and can press «Importer» again.
      const unconfirmed = s.outbox.mode === 'import' && !d.importDone;
      if (s.outbox.mode === 'import') {
        s.importHandled = s.outbox.importOf;
        if (s.importRequest === s.importHandled) s.importRequest = null;
      }
      s.outbox = null;
      s.setAside = { refused: (s.setAside?.refused ?? 0) + (d.refused ?? 0), torn: (s.setAside?.torn ?? 0) + (d.torn ?? 0) };
      s.lastRunAt = iso(now());
      s.lastSuccessAt = iso(now());
      s.lastFailureAt = null;
      s.lastError = unconfirmed ? { class: 'import-unconfirmed', message: 'no import_done in the answer', at: iso(now()) } : null;
      if (!unconfirmed) s.problemShown = null;
      save();
      return { ok: true, sent: d.sent, importDone: d.importDone, refused: d.refused ?? 0, torn: d.torn ?? 0 };
    }
    if (d.class !== 'busy') fail(s, d.class, d.message, now());
    save();
    return { ok: false, class: d.class, message: d.message };
  });
  if (result.ok) removeRunFiles(p, plan.runId);
  return result;
}

// ------------------------------------------------------------------ what SessionStart says

const NOTICES = {
  'node-unreachable': 'the colleague could not be reached, so the distilled work facts wait on this machine and are sent on the next try (every 30 minutes)',
  'node-refused': 'the colleague did not confirm it stored the distilled work facts; they wait on this machine and are sent again',
  'signed-out': 'this Claude Code is no longer signed in to the colleague; the distilled work facts wait on this machine. Call the wybe server\'s `connect` tool to sign in again',
  'distil-failed': 'the background distil did not finish; it runs again in 30 minutes',
  'claude-missing': 'the background distil could not find the claude command on this machine',
  'import-unconfirmed': 'the import was sent, but the colleague did not confirm it; the person can press «Importer» again',
};

/** One line for SessionStart about a delivery problem or dropped notes, told once per kind (QA R4-5). Null when there is nothing new. */
export function distilNotice(p, { now = Date.now() } = {}) {
  let folded = [];
  let saved = false;
  try {
    return locked(p, (s, persist) => {
      const save = () => { persist(); saved = true; };
      folded = foldDropped(p, s);
      const parts = [];
      if (s.dropped && s.dropped.count > (s.droppedShown ?? 0)) {
        const n = s.dropped.count - (s.droppedShown ?? 0);
        parts.push(`${n} session${n === 1 ? '' : 's'} could not be queued for the colleague (the local queue was full) and will not be distilled`);
        s.droppedShown = s.dropped.count;
      }
      const aside = s.setAside ?? { refused: 0, torn: 0 };
      const shown = s.setAsideShown ?? { refused: 0, torn: 0 };
      if (aside.refused > shown.refused) {
        const n = aside.refused - shown.refused;
        parts.push(`the colleague refused ${n} batch${n === 1 ? '' : 'es'} of distilled work facts (it answered with an error, so ${n === 1 ? 'it was' : 'they were'} not stored and will not be sent again)`);
      }
      if (aside.torn > shown.torn) {
        const n = aside.torn - shown.torn;
        parts.push(`${n} batch${n === 1 ? '' : 'es'} of distilled work facts ${n === 1 ? 'was' : 'were'} damaged on this machine's disk before ${n === 1 ? 'it' : 'they'} could be sent, and ${n === 1 ? 'was' : 'were'} set aside; the rest was sent`);
      }
      s.setAsideShown = { refused: aside.refused, torn: aside.torn };
      if (s.lastError && s.problemShown !== s.lastError.class) {
        parts.push(`${NOTICES[s.lastError.class] ?? 'the background distil had a problem'} (${s.lastError.message})`);
        s.problemShown = s.lastError.class;
      }
      if (!parts.length) {
        if (folded.length) save();
        return null;
      }
      save();
      return `wybe-connect: ${parts.join('; ')}. Tell the person once, briefly.`;
    }, { tries: 5, waitMs: 20 });
  } catch (err) {
    if (err?.code === 'ELOCKBUSY') return null;
    throw err;
  } finally {
    if (saved) unlinkAll(folded);
  }
}
