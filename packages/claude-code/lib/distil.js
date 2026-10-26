// The background distil (Claude Code): the person's local sessions become short work facts on
// their colleague's node, each exactly once. The product owner chose:
// a headless `claude -p` in the background, and the hooks send the essence only.
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
// Files under <home>/connections/<name>/ (one distil per connection; all owner-only):
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
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { withLock, acquire, isAlive as defaultAlive } from './lock.js';
import { appendRecord, readRecords } from './ledger.js';
import { paths as legacyPaths, loadCredentials, saveCredentials, readJson, writeJsonPrivate } from './home.js';
import { connectionPaths, checkedName, connectionNames, pinnedConnection, NODE_ENV } from './connections.js';
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
// How much of a transcript's head is read to tell a distil run's own session from the person's.
const HEAD_BYTES = 64 * 1024;
const DISTIL_PROMPT_START = 'wybe-connect distil run';
export const KEEP_LOGS_MS = 14 * 24 * 60 * 60 * 1000;

const PLUGIN_ROOT = join(import.meta.dirname, '..');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const iso = (ms) => new Date(ms).toISOString();
const ms = (at) => (at ? Date.parse(at) : NaN);
const sleep = (n) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);

/**
 * Each connection (lib/connections.js) has a distil of its own, under connections/<name>/: its
 * notes, state, outboxes and locks, so a session's facts reach only the node its session uses.
 * Paths without a connection (the single layout) keep it under state/.
 */
export function distilPaths(p) {
  const base = p.connection ? join(p.root, 'connections', p.connection) : p.state;
  const dir = join(base, 'distil');
  const runs = join(dir, 'runs');
  return {
    dir,
    runs,
    state: join(base, 'distil.json'),
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
  // The "distilled up to" marks: { [node]: { [transcript key]: { path, line, at } } }. A run of a
  // transcript for that node starts after `line`, whatever started the run (a hook, the import, a
  // resume). A mark lives as long as its transcript file does, so no import window and no resume
  // can reach lines it already covers.
  distilled: {},
  running: null, // { runId, mode, importOf, pid, startedAt, transcripts: [{ path, sessionId, cwd, notedAt, fromLine, toLine }] }
  outbox: null, // { runId, mode, importOf, node, doneAt }: distilled for `node`, not yet all acknowledged
  parked: [], // outboxes made for another node than the one connected now: kept, sent only to their own node
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
  // parked: outboxes kept for another node; unsent: parked outboxes deleted past MAX_PARKED.
  setAside: { refused: 0, torn: 0, parked: 0, unsent: 0 },
  setAsideShown: { refused: 0, torn: 0, parked: 0, unsent: 0 },
});

export const MAX_PARKED = 20;

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

/**
 * A connection removed (`connect remove`) while a hook, run or delivery of it was under way: its
 * directory is gone, and nothing may write there again, so it does not come back half.
 */
const gone = (p) => Boolean(p.connection) && !existsSync(p.credentials);

function locked(p, fn, opts = { tries: 40, waitMs: 50 }) {
  if (gone(p)) throw Object.assign(new Error('the connection was removed'), { code: 'ECONNGONE' });
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

/**
 * The node a grant belongs to: the origin of the colleague's address the person connected to
 * (https://<firm>.wybe.me), else its OAuth resource or endpoint. A new sign-in to the same
 * colleague is the same node; connecting to another colleague is another. Null without a grant.
 */
export function nodeOf(c) {
  const raw = [c?.nodeUrl, c?.resource, c?.mcpEndpoint].find((x) => typeof x === 'string' && x);
  if (!raw) return null;
  try {
    return raw === c.nodeUrl ? new URL(raw).origin : raw;
  } catch {
    return raw;
  }
}

const currentNode = (p) => {
  try {
    return nodeOf(loadCredentials(p));
  } catch {
    return null;
  }
};

const noteName = (path) => `${createHash('sha256').update(path).digest('hex').slice(0, 32)}.json`;

/**
 * Stop / SessionEnd / PreCompact: remembers that a transcript has new work. Lock-free: one file
 * per transcript, replaced atomically, so a slow lock holder can never erase it.
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

/** A transcript's identity: its full path, compared the way the file system does. */
export function transcriptKey(path) {
  return process.platform === 'win32' ? win32.resolve(path).toLowerCase() : posix.resolve(path);
}

const marksOf = (s, node) => {
  const all = s.distilled && typeof s.distilled === 'object' ? s.distilled : (s.distilled = {});
  const bucket = all[node ?? ''];
  return bucket && typeof bucket === 'object' && typeof bucket.line !== 'number' ? bucket : null;
};

/** The line a transcript is distilled up to for a node, or null. */
export function markOf(s, node, path) {
  const line = marksOf(s, node)?.[transcriptKey(path)]?.line;
  return typeof line === 'number' ? line : null;
}

function bind(s, run, now) {
  const key = run.node ?? '';
  const marks = marksOf(s, key) ?? (s.distilled[key] = {});
  for (const t of run.transcripts) marks[transcriptKey(t.path)] = { path: t.path, line: t.toLine, at: iso(now) };
  // A mark goes only with its transcript: as long as the file exists, a resume or an import can reach it.
  for (const [node, bucket] of Object.entries(s.distilled)) {
    if (!bucket || typeof bucket !== 'object' || typeof bucket.line === 'number') { delete s.distilled[node]; continue; }
    for (const [k, d] of Object.entries(bucket)) if (typeof d?.path !== 'string' || !existsSync(d.path)) delete bucket[k];
    if (!Object.keys(bucket).length) delete s.distilled[node];
  }
  s.outbox = { runId: run.runId, mode: run.mode, importOf: run.importOf ?? null, node: run.node ?? null, doneAt: iso(now) };
}

const bump = (s, field, n = 1) => {
  s.setAside = { ...structuredClone(EMPTY.setAside), ...(s.setAside ?? {}) };
  s.setAside[field] += n;
};

/** Sets an outbox aside for its own node (never sent to another). Past MAX_PARKED the oldest is deleted, counted. */
function park(p, s, outbox) {
  s.parked = [...(s.parked ?? []), outbox];
  bump(s, 'parked');
  while (s.parked.length > MAX_PARKED) {
    const old = s.parked.shift();
    removeRunFiles(p, old.runId);
    bump(s, 'unsent');
  }
}

/**
 * The outbox to deliver for the node connected now: the current one if it is that node's (another
 * node's is parked first), else a parked one made for this node. Null when there is none.
 */
function outboxFor(p, s, node) {
  if (s.outbox && s.outbox.node && s.outbox.node !== node) {
    park(p, s, s.outbox);
    s.outbox = null;
  }
  if (!s.outbox) {
    const i = (s.parked ?? []).findIndex((x) => x.node === node);
    if (i >= 0) {
      s.outbox = s.parked[i];
      s.parked = s.parked.filter((_, j) => j !== i);
    }
  }
  return s.outbox;
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

/**
 * The oldest pending ranges that have new lines for this node, within the run's caps: each
 * transcript from its mark on, and never twice in one run. Pending entries with nothing new, or
 * whose file is gone, leave pending.
 */
function pick(s, node) {
  const take = [];
  const seen = new Set();
  let chars = 0;
  const keep = [];
  for (const x of s.pending) {
    const key = transcriptKey(x.path);
    if (seen.has(key)) continue; // the same transcript under another spelling: one range is enough
    if (take.length >= MAX_RUN_TRANSCRIPTS || chars + x.path.length > MAX_RUN_PATH_CHARS) {
      keep.push(x);
      continue;
    }
    const toLine = countLines(x.path);
    const fromLine = markOf(s, node, x.path) ?? 0;
    if (toLine === null || toLine <= fromLine) continue; // deleted by Claude Code, or nothing new
    take.push({ ...x, fromLine, toLine });
    seen.add(key);
    chars += x.path.length;
  }
  s.pending = keep;
  return take;
}

/** Claude Code's home: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeHomeOf(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Whether a transcript is a distil run's own session: its first user message is the distil prompt. */
function isDistilSession(path) {
  let head;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  for (const line of head.split('\n')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type !== 'user') continue;
    const c = o.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x?.type === 'text')?.text : null;
    return typeof text === 'string' && text.startsWith(DISTIL_PROMPT_START);
  }
  return false;
}

/** The person's Claude Code transcripts changed in the import window, oldest first, the distil runs' own left out. */
export function importTranscripts(claudeHome, now) {
  const root = join(claudeHome, 'projects');
  const out = [];
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files = [];
    try {
      files = readdirSync(join(root, d.name)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(root, d.name, f);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile() || now - st.mtimeMs > IMPORT_DAYS * 24 * 60 * 60 * 1000) continue;
      if (!safeTranscriptPath(path) || isDistilSession(path)) continue;
      out.push({ path, sessionId: f.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Whether a session's transcript may go into this connection's import: a session fixed to another
 * connection (or to none) belongs to that one, so its work never reaches this node. A session
 * that was never fixed (older than the connections, or never hooked) is the person's for any.
 */
function importable(p, sessionId) {
  try {
    const pin = pinnedConnection(p.root, sessionId);
    return pin === undefined || pin === p.connection;
  } catch {
    return false; // an unreadable pin: not provably ours
  }
}

/**
 * The import: every transcript of the import window joins pending (by its time), so the plugin,
 * not the model, decides what the import reads, and each is read from its mark on like any other
 * run. Past MAX_PENDING the rest wait on disk as notes, folded as room frees.
 */
function enqueueImport(p, s, claudeHome, now) {
  const have = new Set([...s.pending, ...(s.running?.transcripts ?? [])].map((x) => transcriptKey(x.path)));
  for (const t of importTranscripts(claudeHome, now)) {
    const key = transcriptKey(t.path);
    if (have.has(key)) continue;
    if (p.connection && !importable(p, t.sessionId)) continue;
    have.add(key);
    if (s.pending.length + inFlight(s) < MAX_PENDING) s.pending.push({ path: t.path, sessionId: t.sessionId, cwd: null, notedAt: iso(t.mtimeMs) });
    else noteSession(p, { transcriptPath: t.path, sessionId: t.sessionId, now: t.mtimeMs });
  }
  s.pending.sort(byNoted);
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
    if (err?.code === 'ELOCKBUSY' || err?.code === 'ECONNGONE') return false;
    throw err;
  }
}

/**
 * One scheduler tick (a hook, or the MCP server on an import request). Folds notes, settles a
 * dead run, and starts the detached watchdog when there is work: an undelivered outbox first, then
 * an import, then an ongoing run. Returns the plan it started, or null.
 */
export function maybeRun({ paths: p, env = process.env, now = Date.now(), alive = defaultAlive, spawnImpl = defaultSpawn, watchdog = join(PLUGIN_ROOT, 'bin', 'distil-run.js'), claudeHome = claudeHomeOf(env) } = {}) {
  if (env[DISTIL_ENV]) return null; // a distil run's own hooks and server never start another
  if (!hasRemember(p)) return null;
  const dp = distilPaths(p);
  const node = currentNode(p);
  let folded = [];
  let plan;
  try {
    plan = locked(p, (s, save) => {
      folded = foldNotes(p, s);
      reconcile(p, s, now, alive);
      const decided = decide(p, s, now, node, claudeHome);
      if (decided) {
        s.running = { ...decided, pid: null, startedAt: iso(now) };
        if (decided.mode === 'import') s.importRequest = null;
      }
      save();
      return decided;
    });
  } catch (err) {
    if (err?.code === 'ELOCKBUSY' || err?.code === 'ECONNGONE') return null;
    throw err;
  }
  unlinkAll(folded);
  if (!plan) return null;
  const planFile = dp.plan(plan.runId);
  writeJsonPrivate(planFile, { ...plan, root: p.root, connection: p.connection ?? null });
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

/**
 * A hook's tick for every connection of a harness home (lib/connections.js), each in its own
 * paths: a connection's outbox or backlog must not wait for a session of its own, since new
 * sessions may all use another one now. One connection's failure never stops the others.
 * Returns the plans started.
 */
export function maybeRunAll(root, opts = {}) {
  const started = [];
  for (const key of connectionNames(root)) {
    try {
      const plan = maybeRun({ ...opts, paths: connectionPaths(root, key) });
      if (plan) started.push(plan);
    } catch {
      // that connection's next tick
    }
  }
  return started;
}

function decide(p, s, now, node, claudeHome) {
  if (s.running) return null;
  const backoff = Number.isFinite(ms(s.lastFailureAt)) && now - ms(s.lastFailureAt) < BACKOFF_MS;
  if (backoff) return null;
  // 128 random bits: the node keeps a key once per PERSON across all their assistants and machines
  // (wybe-node#844), and every key derives from the run id, so two runs must never share one.
  const runId = `${iso(now).replace(/[:.]/g, '-')}-${randomBytes(16).toString('hex')}`;
  const outbox = outboxFor(p, s, node);
  if (outbox) return { runId: outbox.runId, mode: 'deliver', importOf: outbox.importOf, node: outbox.node ?? node, transcripts: [] };
  if (s.importRequest && s.importRequest !== s.importHandled) {
    enqueueImport(p, s, claudeHome, now);
    return { runId, mode: 'import', importOf: s.importRequest, node, claudeHome, transcripts: pick(s, node) };
  }
  if (!s.pending.length) return null;
  const since = now - ms(s.lastSuccessAt);
  const due = !Number.isFinite(since) || since >= ONGOING_INTERVAL_MS || (s.pending.length > MAX_RUN_TRANSCRIPTS && since >= BACKLOG_INTERVAL_MS);
  if (!due) return null;
  const transcripts = pick(s, node);
  return transcripts.length ? { runId, mode: 'ongoing', importOf: null, node, transcripts } : null;
}

// ------------------------------------------------------------------ the outbox (written by the run's MCP server)

// One key per outbox record, bound to the node the run distils for. A record never changes once
// written, and a redone distil is a new run with new keys, so a key is never reused for new
// content (the node would replay the old answer), and no two nodes ever see the same key.
export const recordKey = (node, runId, seq) => `wc1-${createHash('sha256').update(`${node ?? ''}\n${runId}:${seq}`).digest('hex')}`;

function outboxRecords(p, runId) {
  return readRecords(distilPaths(p).outbox(runId));
}

/** The run's `remember`: redacted, then appended, keyed for the run's node. Returns { seq } or { error }. */
export function spoolRemember(p, runId, args) {
  if (gone(p)) return { error: 'the connection this distil run is for was removed' };
  const { records } = outboxRecords(p, runId);
  if (records.some((r) => r.kind === 'done')) return { error: 'this distil run already called distil_done' };
  const seq = records.filter((r) => r.kind === 'remember').reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  const { value } = redactValue(args);
  const node = readJson(distilPaths(p).plan(runId))?.node ?? currentNode(p);
  appendRecord(distilPaths(p).outbox(runId), { kind: 'remember', seq, key: recordKey(node, runId, seq), args: value });
  return { seq };
}

/** The run's `distil_done`: closes the outbox with the number of calls it holds. */
export function spoolDone(p, runId) {
  if (gone(p)) return { error: 'the connection this distil run is for was removed' };
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
    // An outbox is sent only to the node it was distilled for, whatever the person connected since.
    if (c && run.node && nodeOf(c) !== run.node) return { ok: false, class: 'node-changed', message: 'this Claude Code is now connected to another colleague', importDone, sent };
    // The connection's grant may be removed or replaced (a new sign-in gets a new grantId,
    // lib/connections.js) while this delivery runs: then it stops, writes no tokens, and the next
    // tick delivers what is left with the grant on disk by then.
    const grantId = c?.grantId ?? null;
    const replaced = () => {
      try {
        const onDisk = readJson(p.credentials);
        return !onDisk || (onDisk.grantId ?? null) !== grantId;
      } catch {
        return true;
      }
    };
    const changed = () => ({ ok: false, class: 'grant-changed', message: 'the connection was removed or signed in again while the facts were sent', importDone, sent });
    for (const r of order) {
      if (acked.has(r.seq)) continue;
      if (!c) return { ok: false, class: 'signed-out', message: 'not connected to a Wybe AI colleague', importDone, sent };
      if (replaced()) return changed();
      const args = { ...r.args, idempotency_key: r.key };
      let out = await callTool({ endpoint: c.mcpEndpoint, accessToken: c.accessToken, name: 'remember', args, fetchImpl, timeoutMs });
      if (!out.ok && out.kind === 'auth' && c.refreshToken) {
        const next = await refreshTokens({ tokenEndpoint: c.tokenEndpoint, clientId: c.clientId, refreshToken: c.refreshToken, resource: c.resource ?? c.mcpEndpoint, requestedScopes: c.scopes, fetchImpl, now: now() });
        if (next) {
          if (replaced()) return changed();
          c = { ...c, ...next };
          saveCredentials(c, p);
          out = await callTool({ endpoint: c.mcpEndpoint, accessToken: c.accessToken, name: 'remember', args, fetchImpl, timeoutMs });
        }
      }
      if (gone(p)) return changed(); // removed while the call ran: its files are gone, write none back
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
  lines.push('Read only those ranges: never another transcript, nor other lines of these. What lies outside them was distilled already, and reading it again would store the same facts twice.');
  if (plan.mode === 'import') {
    const home = plan.claudeHome ?? '~/.claude';
    lines.push(
      '',
      `This is the import the person asked for in Wybe. The ranges above are every Claude Code session of the last ${IMPORT_DAYS} days that is not distilled yet. Also read ${join(home, 'CLAUDE.md')}, the CLAUDE.md of the projects in those transcripts, and the auto memory under ${join(home, 'projects', '*', 'memory')}.`,
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

/** The environment of a run's claude and its MCP server: the run, the home, and the connection the run is for. */
const runEnv = (plan, root) => ({ [DISTIL_ENV]: plan.runId, WYBE_CONNECT_HOME: root, [NODE_ENV]: typeof plan.connection === 'string' ? plan.connection : '' });

export function claudeArgs(plan, { root, pluginRoot = PLUGIN_ROOT }) {
  const mcp = { mcpServers: { wybe: { command: process.execPath, args: [join(pluginRoot, 'bin', 'mcp-proxy.js')], env: runEnv(plan, root) } } };
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
      child = spawnImpl(how.cmd, [...how.pre, ...claudeArgs(plan, { root })], { stdio: ['ignore', io, io], windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, ...runEnv(plan, root) } });
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
 * The paths a plan's run works in: those of the connection it was planned for (lib/connections.js),
 * or the single-connection layout for a plan made without one. Null when the plan names no valid connection.
 */
export function planPaths(plan, root) {
  if (plan?.connection === null || plan?.connection === undefined) return legacyPaths(root);
  try {
    return connectionPaths(root, checkedName(plan.connection));
  } catch {
    return null;
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
      bump(s, 'refused', d.refused ?? 0);
      bump(s, 'torn', d.torn ?? 0);
      s.lastRunAt = iso(now());
      s.lastSuccessAt = iso(now());
      s.lastFailureAt = null;
      s.lastError = unconfirmed ? { class: 'import-unconfirmed', message: 'no import_done in the answer', at: iso(now()) } : null;
      if (!unconfirmed) s.problemShown = null;
      save();
      return { ok: true, sent: d.sent, importDone: d.importDone, refused: d.refused ?? 0, torn: d.torn ?? 0 };
    }
    if (d.class === 'node-changed') {
      park(p, s, s.outbox); // not a failure: it waits for its own node
      s.outbox = null;
    } else if (d.class !== 'busy' && d.class !== 'grant-changed') fail(s, d.class, d.message, now());
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

/** One line for SessionStart about a delivery problem or dropped notes, told once per kind. Null when there is nothing new. */
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
      const aside = { ...structuredClone(EMPTY.setAside), ...(s.setAside ?? {}) };
      const shown = { ...structuredClone(EMPTY.setAsideShown), ...(s.setAsideShown ?? {}) };
      if (aside.parked > shown.parked) {
        const n = aside.parked - shown.parked;
        parts.push(`${n} batch${n === 1 ? '' : 'es'} of distilled work facts ${n === 1 ? 'was' : 'were'} made for another colleague than the one this Claude Code is connected to now; ${n === 1 ? 'it is' : 'they are'} kept on this machine and sent only to that colleague, if this Claude Code connects to it again`);
      }
      if (aside.unsent > shown.unsent) {
        const n = aside.unsent - shown.unsent;
        parts.push(`${n} older batch${n === 1 ? '' : 'es'} kept for other colleagues ${n === 1 ? 'was' : 'were'} deleted unsent (at most ${MAX_PARKED} are kept)`);
      }
      if (aside.refused > shown.refused) {
        const n = aside.refused - shown.refused;
        parts.push(`the colleague refused ${n} batch${n === 1 ? '' : 'es'} of distilled work facts (it answered with an error, so ${n === 1 ? 'it was' : 'they were'} not stored and will not be sent again)`);
      }
      if (aside.torn > shown.torn) {
        const n = aside.torn - shown.torn;
        parts.push(`${n} batch${n === 1 ? '' : 'es'} of distilled work facts ${n === 1 ? 'was' : 'were'} damaged on this machine's disk before ${n === 1 ? 'it' : 'they'} could be sent, and ${n === 1 ? 'was' : 'were'} set aside; the rest was sent`);
      }
      s.setAsideShown = { ...aside };
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
    if (err?.code === 'ELOCKBUSY' || err?.code === 'ECONNGONE') return null;
    throw err;
  } finally {
    if (saved) unlinkAll(folded);
  }
}
