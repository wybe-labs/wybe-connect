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
//
// The import lists every transcript still on disk, however old, and reads them grouped by project,
// with the person's memory files (CLAUDE.md, auto memory, AGENTS.md). The run sends one summary per
// project besides the facts. A memory file is read again only when its content changed (per node,
// like the line marks). A transcript no session pin assigns goes to the first connection whose
// import takes it (lib/claims.js).
//
// Codex has the same pipeline (a plan's `harness`): its hooks note rollouts, the run is a headless
// `codex exec` (read-only sandbox, ephemeral, only the plugin's own server, in distil mode), and
// the import lists the person's rollouts under <CODEX_HOME>/sessions. What differs per harness is
// only: how the runner is found, its arguments, the prompt's reading instructions, and where the
// transcripts and memory files are.

import { spawn as defaultSpawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { withLock, acquire, isAlive as defaultAlive } from './lock.js';
import { claim, claimKey, claims } from './claims.js';
import { appendRecord, readRecords } from './ledger.js';
import { paths as legacyPaths, harnessHome, loadCredentials, saveCredentials, readJson, writeJsonPrivate } from './home.js';
import { rolloutHead, stripCodexInjected } from './codex-rollout.js';
import { connectionPaths, checkedName, connectionNames, recordTranscript, sessionLines, NODE_ENV } from './connections.js';
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
// Memory files one run reads; the rest have no mark yet and so are read by the next runs.
export const MAX_RUN_MEMORY_FILES = 40;
// A record the node answers "busy" (its daily budget or rate limit) this many times is set aside.
export const MAX_BUSY = 5;
// An import reads every transcript on disk, a head each. One scheduler tick (a hook, or the MCP
// server between its client's messages) reads at most this many, and the next tick goes on from
// there, so neither waits for a whole disk.
export const IMPORT_SCAN_FILES = 100;
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
    settings: (runId) => join(runs, `${runId}.settings.json`), // claude's own settings, for the run's lifetime
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
  // What each memory file was when a run for that node last read it: { [node]: { [path]: sha256 } }.
  // Set with the line marks, after a whole outbox; a mark goes with its file.
  memoryMarks: {},
  // Memory files a run left past MAX_RUN_MEMORY_FILES: [{ path, shared }], read by the next runs
  // (one of their own when no transcript waits).
  memoryBacklog: [],
  running: null, // { runId, mode, importOf, pid, startedAt, transcripts: [{ path, sessionId, cwd, project, notedAt, fromLine, toLine }], memory: [{ path, sha256 }] }
  outbox: null, // { runId, mode, importOf, node, doneAt }: distilled for `node`, not yet all acknowledged
  parked: [], // outboxes made for another node than the one connected now: kept, sent only to their own node
  importRequest: null,
  importHandled: null,
  // An import still reading the disk: { importOf, after: the last file read, as path segments under
  // the harness home, dirs: projects/<dir> names of the transcripts it took so far }.
  importScan: null,
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
  if (p.root && typeof sessionId === 'string') recordTranscript(p.root, sessionId, path); // a move counts these lines
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
  return claimKey(path);
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

const memoryMarksOf = (s, node) => {
  const all = s.memoryMarks && typeof s.memoryMarks === 'object' ? s.memoryMarks : (s.memoryMarks = {});
  const bucket = all[node ?? ''];
  return bucket && typeof bucket === 'object' ? bucket : null;
};

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
  const memory = (Array.isArray(run.memory) ? run.memory : []).filter((f) => typeof f?.path === 'string' && typeof f.sha256 === 'string');
  const read = memoryMarksOf(s, key); // also makes s.memoryMarks an object
  if (memory.length) {
    const into = read ?? (s.memoryMarks[key] = {});
    for (const f of memory) into[f.path] = f.sha256;
  }
  for (const [node, bucket] of Object.entries(s.memoryMarks)) {
    if (!bucket || typeof bucket !== 'object') { delete s.memoryMarks[node]; continue; }
    for (const path of Object.keys(bucket)) if (!existsSync(path)) delete bucket[path];
    if (!Object.keys(bucket).length) delete s.memoryMarks[node];
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
  unlinkAll([dp.plan(runId), dp.outbox(runId), dp.acks(runId), dp.settings(runId)]);
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
  returnMemory(s, r);
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
 * transcript from its mark on, and never twice in one run. A moved session's transcript gives this
 * node only the lines written while the session was on it (lib/connections.js sessionLines), one
 * stretch per run; one with a later stretch here stays pending. Pending entries with nothing new,
 * whose file is gone, or with no lines here (moved away, pinned to none, or claimed by another
 * connection's import) leave pending. An import (`grouped`) takes whole projects, the project with
 * the oldest transcript first, so each project's summary is written from all of it the caps allow.
 */
function pick(p, s, node, { harness = 'claude-code', grouped = false } = {}) {
  const take = [];
  const seen = new Set();
  let chars = 0;
  const keep = [];
  const claimed = p.connection ? claims(p.root) : null;
  for (const x of grouped ? byProject(s.pending, harness) : s.pending) {
    const here = p.connection ? linesHere(p, x.sessionId) : null;
    if (here && !here.length) continue; // its lines belong to another connection, or to none
    const key = transcriptKey(x.path);
    if (!here && claimed?.[key] !== undefined && claimed[key] !== p.connection) continue; // another connection's import took it
    if (seen.has(key)) continue; // the same transcript under another spelling: one range is enough
    if (take.length >= MAX_RUN_TRANSCRIPTS || chars + x.path.length > MAX_RUN_PATH_CHARS) {
      keep.push(x);
      continue;
    }
    const lines = countLines(x.path);
    if (lines === null) continue; // deleted by Claude Code
    const mark = markOf(s, node, x.path) ?? 0;
    let fromLine = mark;
    let toLine = lines;
    let later = false;
    if (here) {
      const i = here.findIndex(([, end]) => end === null || end > mark);
      if (i < 0) continue; // every stretch here is read
      fromLine = Math.max(mark, here[i][0]);
      if (here[i][1] !== null) toLine = Math.min(lines, here[i][1]);
      later = here.slice(i + 1).some(([from]) => from < lines);
    }
    if (later) keep.push(x);
    if (toLine <= fromLine) continue; // nothing new
    take.push({ ...x, project: projectOf(harness, x), fromLine, toLine });
    seen.add(key);
    chars += x.path.length;
  }
  s.pending = grouped ? keep.sort(byNoted) : keep;
  return take;
}

/** Pending entries by project: the project with the oldest transcript first, then by name, then each oldest first. */
function byProject(list, harness) {
  const oldest = new Map();
  for (const x of list) {
    const name = projectOf(harness, x);
    const at = ms(x.notedAt);
    if (!(oldest.get(name) <= at)) oldest.set(name, at);
  }
  const byName = (a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0);
  return [...list].sort((a, b) => oldest.get(a.project) - oldest.get(b.project) || byName(a, b) || byNoted(a, b));
}

/** A project's name: the last part of its folder, never a path, so no plan or prompt says where it lies. */
function projectName(folder) {
  if (typeof folder !== 'string') return null;
  const name = folder.split(/[\\/]+/).filter(Boolean).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
  return name || null;
}

/**
 * A pending entry's project, kept on the entry: for Codex the rollout's session_meta cwd; for
 * Claude Code the first cwd its transcript carries, else the cwd its hook gave, else its
 * projects/<dir> name (lossy: a dash there may have been a separator). The entry's cwd becomes the
 * transcript's own when it tells one, so its project folder's memory files can be found.
 */
function projectOf(harness, x) {
  if (typeof x.project === 'string') return x.project;
  let cwd = null;
  if (harness === 'codex') {
    try {
      cwd = rolloutHead(x.path)?.cwd ?? null;
    } catch {
      cwd = null;
    }
  } else cwd = sessionHead(x.path).cwd;
  if (cwd) x.cwd = cwd.slice(0, MAX_PATH_CHARS);
  x.project = projectFrom(harness, x.path, x.cwd);
  return x.project;
}

const projectFrom = (harness, path, cwd) => projectName(cwd) ?? (harness === 'codex' ? null : projectName(basename(dirname(path)).replace(/-/g, '/'))) ?? 'other';

/** The projects/<dir> names under a Claude Code home that hold these transcripts. */
function projectDirsOf(home, entries) {
  const root = claimKey(join(home, 'projects'));
  const dirs = new Set();
  for (const x of entries) {
    if (typeof x?.path !== 'string') continue;
    const dir = dirname(x.path);
    if (claimKey(dirname(dir)) === root) dirs.add(basename(dir));
  }
  return [...dirs].sort();
}

const safeMemoryPath = (path) => path.length <= MAX_PATH_CHARS && !/[\u0000-\u001f\u007f]/.test(path);

/**
 * The person's memory files for some projects, each { path, shared }: for Claude Code the home's
 * CLAUDE.md, projects/<dir>/memory/**.md for each of `dirs` (the projects/<dir> names of the
 * transcripts a run takes, never every project's), and CLAUDE.md and .claude/CLAUDE.md in each of
 * `cwds` still on disk; for Codex the home's AGENTS.md and AGENTS.md in each of `cwds`. `shared`
 * (the home's own file) is the person's for every connection; a project's are claimed like an
 * unpinned transcript (lib/claims.js).
 */
export function memoryFiles(harness, home, cwds, dirs = []) {
  const out = [];
  const seen = new Set();
  const add = (path, shared = false) => {
    const key = transcriptKey(path);
    if (seen.has(key) || !safeMemoryPath(path)) return;
    try {
      if (!statSync(path).isFile()) return;
    } catch {
      return;
    }
    seen.add(key);
    out.push({ path, shared });
  };
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(path, depth + 1);
      else if (e.isFile() && e.name.endsWith('.md')) add(path);
    }
  };
  if (harness === 'codex') {
    add(join(home, 'AGENTS.md'), true);
    for (const cwd of cwds) add(join(cwd, 'AGENTS.md'));
    return out;
  }
  add(join(home, 'CLAUDE.md'), true);
  for (const d of dirs) if (typeof d === 'string' && d && d !== '.' && d !== '..' && !/[\\/]/.test(d)) walk(join(home, 'projects', d, 'memory'), 0);
  for (const cwd of cwds) {
    add(join(cwd, 'CLAUDE.md'));
    add(join(cwd, '.claude', 'CLAUDE.md'));
  }
  return out;
}

const cwdsOf = (entries) => [...new Set(entries.map((x) => x.cwd).filter((c) => typeof c === 'string' && c && (win32.isAbsolute(c) || posix.isAbsolute(c))))];

const backlogOf = (s) => (Array.isArray(s.memoryBacklog) ? s.memoryBacklog : []).filter((f) => typeof f?.path === 'string' && safeMemoryPath(f.path)).map((f) => ({ path: f.path, shared: f.shared === true }));

/** Puts a run's memory files back first in the backlog: the run that was to read them did not finish. */
function returnMemory(s, run) {
  const home = harnessOf(run) === 'codex' ? run.codexHome : run.claudeHome;
  const shared = typeof home === 'string' ? claimKey(join(home, harnessOf(run) === 'codex' ? 'AGENTS.md' : 'CLAUDE.md')) : null;
  const back = (Array.isArray(run.memory) ? run.memory : []).filter((f) => typeof f?.path === 'string').map((f) => ({ path: f.path, shared: claimKey(f.path) === shared }));
  const have = new Set(back.map((f) => claimKey(f.path)));
  s.memoryBacklog = [...back, ...backlogOf(s).filter((f) => !have.has(claimKey(f.path)))];
}

/**
 * The memory files a run reads, each { path, sha256 }: the backlog first, then those of the run's
 * own projects (`cwds`, `dirs`). An import lists all of them, any other run those whose content
 * changed since a run for this node last read them. Past MAX_RUN_MEMORY_FILES the rest wait in
 * the backlog, unmarked, for the next runs.
 */
function planMemory(p, s, node, harness, home, cwds, dirs, importing) {
  const found = memoryFiles(harness, home, cwds, dirs);
  const seen = new Set(found.map((f) => claimKey(f.path)));
  let files = [...backlogOf(s).filter((f) => !seen.has(claimKey(f.path))), ...found];
  if (p.connection) {
    const mine = claim(p.root, p.connection, files.filter((f) => !f.shared).map((f) => f.path));
    files = files.filter((f) => f.shared || mine.has(claimKey(f.path)));
  }
  const read = memoryMarksOf(s, node) ?? {};
  const out = [];
  const rest = [];
  for (const f of files) {
    let sha256;
    try {
      sha256 = createHash('sha256').update(readFileSync(f.path)).digest('hex');
    } catch {
      continue;
    }
    if (!importing && read[f.path] === sha256) continue;
    if (out.length < MAX_RUN_MEMORY_FILES) out.push({ path: f.path, sha256 });
    else rest.push({ path: f.path, shared: f.shared });
  }
  s.memoryBacklog = rest;
  return out;
}

/** Claude Code's home: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeHomeOf(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Codex's home: CODEX_HOME when set, else ~/.codex. */
export function codexHomeOf(env = process.env) {
  return env.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex');
}

const harnessOf = (plan) => (plan?.harness === 'codex' ? 'codex' : 'claude-code');

/**
 * The wybe-connect home a harness home lies in (lib/home.js harnessHome): what the watchdog and
 * the run's MCP server are started with, so their own harnessHome() finds the same connection.
 */
function wybeHomeOf(root, harness) {
  const up = dirname(root);
  return harness !== 'claude-code' && join(harnessHome(harness, up)) === join(root) ? up : root;
}

/** Reads at most `bytes` of a file's head as text, or null. */
function headText(path, bytes) {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// A rollout's session_meta carries the base instructions, so the first prompt can lie far in.
const CODEX_HEAD_BYTES = 1024 * 1024;

/** Whether a rollout is a distil run's own thread: the first prompt the person "typed" is the distil prompt. */
function isCodexDistilRollout(path) {
  const head = headText(path, CODEX_HEAD_BYTES);
  if (head === null) return false;
  for (const line of head.split('\n')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type !== 'event_msg') continue;
    const p = o.payload ?? {};
    let text = null;
    if (p.type === 'user_message' && typeof p.message === 'string') text = p.message;
    else if (p.type === 'item_completed' && p.item?.type === 'UserMessage' && Array.isArray(p.item.content)) text = p.item.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
    if (text === null) continue;
    return stripCodexInjected(text).startsWith(DISTIL_PROMPT_START);
  }
  return false;
}

/**
 * Every Codex rollout of the person's still on disk, however old, oldest first (by the file's own
 * time: a session resumed later keeps its first day's folder): <codexHome>/sessions/YYYY/MM/DD/
 * rollout-*.jsonl. Subagent and internal threads (session_meta.source), distil runs' own threads
 * and compressed rollouts are left out.
 */
export function importRollouts(codexHome) {
  return scanRollouts(codexHome, null, Infinity).found;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byMtime = (a, b) => a.mtimeMs - b.mtimeMs;

/**
 * Walks the files `depth` folders below `root` in name order, starting after `after` (the path
 * segments below `root` of the last file an earlier walk took), and hands at most `limit` of those
 * `want` accepts to `take`. Returns { done, after }: done once the walk reached the end; else
 * `after` is where the next walk starts.
 */
function walkFrom(root, depth, after, limit, want, take) {
  let n = 0;
  let last = null;
  const walk = (dir, level, prefix, from) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort(byName);
    } catch {
      return true;
    }
    for (const e of entries) {
      if (from && e.name < from[0]) continue;
      const segments = [...prefix, e.name];
      if (level < depth) {
        if (e.isDirectory() && !walk(join(dir, e.name), level + 1, segments, from && e.name === from[0] ? from.slice(1) : null)) return false;
        continue;
      }
      if ((from && e.name <= from[0]) || !want(e)) continue;
      if (n >= limit) return false;
      n += 1;
      last = segments;
      take(join(dir, e.name), e);
    }
    return true;
  };
  const from = Array.isArray(after) && after.length === depth + 1 && after.every((x) => typeof x === 'string') ? after : null;
  const done = walk(root, 0, [], from);
  return { done, after: done ? null : last };
}

/** One stretch of the Codex import's walk: at most `limit` rollouts after `after`, taken as importRollouts takes them. */
function scanRollouts(codexHome, after, limit) {
  const found = [];
  const step = walkFrom(join(codexHome, 'sessions'), 3, after, limit, (e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'), (path) => {
    let st;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (!safeTranscriptPath(path)) return;
    let head = null;
    try {
      head = rolloutHead(path);
    } catch {
      head = null;
    }
    if (!head?.personThread || isCodexDistilRollout(path)) return;
    found.push({ path, sessionId: head.sessionId, mtimeMs: st.mtimeMs, cwd: typeof head.cwd === 'string' && head.cwd ? head.cwd : null });
  });
  return { ...step, found: found.sort(byMtime) };
}

/**
 * One read of a transcript's head: whether it is a distil run's own session (its first user
 * message is the distil prompt), and the first `cwd` it carries, or null.
 */
function sessionHead(path) {
  const head = headText(path, HEAD_BYTES);
  if (head === null) return { distil: false, cwd: null };
  let distil = null;
  let cwd = null;
  for (const line of head.split('\n')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (cwd === null && typeof o?.cwd === 'string' && o.cwd) cwd = o.cwd;
    if (distil === null && o?.type === 'user') {
      const c = o.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x?.type === 'text')?.text : null;
      distil = typeof text === 'string' && text.startsWith(DISTIL_PROMPT_START);
    }
    if (distil !== null && cwd !== null) break;
  }
  return { distil: distil === true, cwd };
}

/** Every Claude Code transcript of the person's still on disk, however old, oldest first, the distil runs' own left out. */
export function importTranscripts(claudeHome) {
  return scanTranscripts(claudeHome, null, Infinity).found;
}

/** One stretch of the Claude Code import's walk: at most `limit` transcripts after `after`, taken as importTranscripts takes them. */
function scanTranscripts(claudeHome, after, limit) {
  const found = [];
  const step = walkFrom(join(claudeHome, 'projects'), 1, after, limit, (e) => e.name.endsWith('.jsonl'), (path, e) => {
    let st;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (!st.isFile() || !safeTranscriptPath(path)) return;
    const head = sessionHead(path);
    if (head.distil) return;
    found.push({ path, sessionId: e.name.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs, cwd: head.cwd });
  });
  return { ...step, found: found.sort(byMtime) };
}

/**
 * The lines of a session's transcript that may go into this connection's distil, an import's or an ongoing run's:
 * the stretches the session spent on this connection, so its work on another (or on none) never reaches this
 * node. Null for a session that was never fixed (older than the connections, or never hooked): the person's for any.
 */
function linesHere(p, sessionId) {
  try {
    return sessionLines(p.root, sessionId, p.connection);
  } catch {
    return []; // an unreadable pin: not provably ours
  }
}

/**
 * The import: every transcript still on disk joins pending (by its time), so the plugin, not the
 * model, decides what the import reads, and each is read from its mark on like any other run.
 * `stretch` is the part of the disk one tick read (scanTranscripts, scanRollouts). Pending keeps
 * the oldest: past MAX_PENDING the newest wait on disk as notes, whichever tick found them, folded
 * as room frees. With connections, a transcript pinned elsewhere is left out, and one no pin
 * assigns is claimed for this connection unless another connection's import claimed it first
 * (lib/claims.js).
 */
function enqueueImport(p, s, harness, stretch) {
  const have = new Set([...s.pending, ...(s.running?.transcripts ?? [])].map((x) => transcriptKey(x.path)));
  const found = stretch.filter((t) => !have.has(transcriptKey(t.path)));
  const lines = new Map(found.map((t) => [t.path, p.connection ? linesHere(p, t.sessionId) : null]));
  const mine = p.connection ? claim(p.root, p.connection, found.filter((t) => lines.get(t.path) === null).map((t) => t.path)) : null;
  const owned = [];
  const fresh = [];
  for (const t of found) {
    const key = transcriptKey(t.path);
    const here = lines.get(t.path);
    if (here?.length === 0) continue;
    if (mine && here === null && !mine.has(key)) continue; // another connection's import took it
    owned.push(t);
    if (have.has(key)) continue;
    have.add(key);
    // The head was read once already: its cwd and project ride along, so planning never reads it again.
    const cwd = t.cwd ? t.cwd.slice(0, MAX_PATH_CHARS) : null;
    fresh.push({ path: t.path, sessionId: t.sessionId, cwd, project: projectFrom(harness, t.path, cwd), notedAt: iso(t.mtimeMs) });
  }
  const all = [...s.pending, ...fresh].sort(byNoted);
  const room = Math.max(0, MAX_PENDING - inFlight(s));
  s.pending = all.slice(0, room);
  for (const x of all.slice(room)) noteSession(p, { transcriptPath: x.path, sessionId: x.sessionId, cwd: x.cwd, now: ms(x.notedAt) });
  return owned;
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
 * an import, then an ongoing run. An import reads the disk IMPORT_SCAN_FILES transcripts a tick,
 * and the tick that reads the last of it starts the run. `harness` ('claude-code' or 'codex')
 * picks the runner and where an import finds the transcripts. Returns the plan it started, or null.
 */
export function maybeRun(opts = {}) {
  return tick(opts).plan;
}

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
const pause = (msec) => new Promise((resolve) => setTimeout(resolve, msec));

/**
 * The MCP server's ticks on an import request: one after another until one starts a run or the
 * import has no more disk to read, with a turn of the event loop between them, so the server keeps
 * answering its client while a large disk is read. A busy lock is tried again a few times.
 * Returns the plan started, or null.
 */
export async function maybeRunUntilPlanned(opts = {}) {
  for (let busy = 0; ;) {
    const { plan, more, lockBusy } = tick(opts);
    if (plan) return plan;
    if (lockBusy) {
      if (++busy > 20) return null;
      await pause(100);
      continue;
    }
    if (!more) return null;
    busy = 0;
    await yieldTurn();
  }
}

const SCANNING = Symbol('the import is still reading the disk');

function tick({ paths: p, env = process.env, now = Date.now(), alive = defaultAlive, spawnImpl = defaultSpawn, watchdog = join(PLUGIN_ROOT, 'bin', 'distil-run.js'), harness = 'claude-code', claudeHome = claudeHomeOf(env), codexHome = codexHomeOf(env) } = {}) {
  const none = { plan: null, more: false, lockBusy: false };
  if (env[DISTIL_ENV]) return none; // a distil run's own hooks and server never start another
  if (!hasRemember(p)) return none;
  const dp = distilPaths(p);
  const node = currentNode(p);
  let folded = [];
  let plan;
  let more = false;
  try {
    plan = locked(p, (s, save) => {
      folded = foldNotes(p, s);
      reconcile(p, s, now, alive);
      let decided = decide(p, s, now, node, harness, harness === 'codex' ? codexHome : claudeHome);
      if (decided === SCANNING) {
        more = true;
        decided = null;
      }
      if (decided) {
        s.running = { ...decided, pid: null, startedAt: iso(now) };
        if (decided.mode === 'import') s.importRequest = null;
      }
      save();
      return decided;
    });
  } catch (err) {
    if (err?.code === 'ELOCKBUSY') return { ...none, lockBusy: true };
    if (err?.code === 'ECONNGONE') return none;
    throw err;
  }
  unlinkAll(folded);
  if (!plan) return { ...none, more };
  const planFile = dp.plan(plan.runId);
  writeJsonPrivate(planFile, { ...plan, root: p.root, connection: p.connection ?? null });
  mkdirSync(dp.runs, { recursive: true, mode: 0o700 });
  let pid = null;
  try {
    const child = spawnImpl(process.execPath, [watchdog, planFile], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, WYBE_CONNECT_HOME: wybeHomeOf(p.root, harness) } });
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
  return { plan: { ...plan, planFile }, more: false, lockBusy: false };
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

function decide(p, s, now, node, harness, home) {
  if (s.running) return null;
  const backoff = Number.isFinite(ms(s.lastFailureAt)) && now - ms(s.lastFailureAt) < BACKOFF_MS;
  if (backoff) return null;
  // 128 random bits: the node keeps a key once per PERSON across all their assistants and machines
  // (the node's idempotency store), and every key derives from the run id, so two runs must never share one.
  const runId = `${iso(now).replace(/[:.]/g, '-')}-${randomBytes(16).toString('hex')}`;
  // Claude Code's plans keep their earlier shape; a Codex plan says so.
  const of = harness === 'codex' ? { harness } : {};
  // Every run that reads memory carries its home, so a failed one gives the home's own file back as the person's.
  const homeOf = harness === 'codex' ? { codexHome: home } : { claudeHome: home };
  const outbox = outboxFor(p, s, node);
  if (outbox) return { runId: outbox.runId, mode: 'deliver', importOf: outbox.importOf, node: outbox.node ?? node, ...of, transcripts: [] };
  if (s.importRequest && s.importRequest !== s.importHandled) {
    const scan = s.importScan?.importOf === s.importRequest ? s.importScan : { importOf: s.importRequest, after: null, dirs: [] };
    const step = (harness === 'codex' ? scanRollouts : scanTranscripts)(home, scan.after, IMPORT_SCAN_FILES);
    const owned = enqueueImport(p, s, harness, step.found);
    // Memory only of the projects this connection takes: those of the transcripts it owns on disk.
    const dirs = [...new Set([...(Array.isArray(scan.dirs) ? scan.dirs.filter((d) => typeof d === 'string') : []), ...projectDirsOf(home, owned)])].sort();
    if (!step.done) {
      s.importScan = { importOf: s.importRequest, after: step.after, dirs };
      return SCANNING;
    }
    s.importScan = null;
    const transcripts = pick(p, s, node, { harness, grouped: true });
    const ours = [...transcripts, ...s.pending];
    const memory = planMemory(p, s, node, harness, home, cwdsOf(ours), [...new Set([...projectDirsOf(home, ours), ...dirs])].sort(), true);
    return { runId, mode: 'import', importOf: s.importRequest, node, ...of, ...homeOf, transcripts, memory };
  }
  const backlog = backlogOf(s).length > 0;
  if (!s.pending.length && !backlog) return null;
  const since = now - ms(s.lastSuccessAt);
  const due = !Number.isFinite(since) || since >= ONGOING_INTERVAL_MS || ((s.pending.length > MAX_RUN_TRANSCRIPTS || backlog) && since >= BACKLOG_INTERVAL_MS);
  if (!due) return null;
  const transcripts = pick(p, s, node, { harness });
  // An ongoing run with no transcript reads only memory the cap left over.
  const memory = planMemory(p, s, node, harness, home, cwdsOf(transcripts), projectDirsOf(home, transcripts), false);
  return transcripts.length || memory.length ? { runId, mode: 'ongoing', importOf: null, node, ...of, ...homeOf, transcripts, memory } : null;
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

// The node's refusal when its daily budget or rate limit is reached: the record is fine, the timing is not.
const isBusy = (out) => out.retry === true || /try again later/i.test(String(out.message ?? ''));

/**
 * Sends every record of the outbox the node has not settled, in order (the record carrying
 * import_of last), and appends each answer to the acks file. An ack is a JSON-RPC result that is
 * not an error, says ok: true and has a numeric `stored`. A tool error that says the node is busy
 * (retry: true, or "try again later") is noted as { busy: n } and stops delivery as class
 * node-busy: the record is sent again after the backoff with the same key, and set aside as refused
 * at its MAX_BUSY-th busy answer. Any other tool error is the node refusing that record for good:
 * it is recorded as refused, never re-sent, and delivery goes on. An outbox line
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
    const acked = new Set(acks.filter((a) => a.refused === true || typeof a.stored === 'number').map((a) => a.seq));
    const busyOf = (seq) => acks.reduce((n, a) => (a.seq === seq && typeof a.busy === 'number' ? Math.max(n, a.busy) : n), 0);
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
        const message = String(out.message).slice(0, 200);
        const busy = isBusy(out) ? busyOf(r.seq) + 1 : 0;
        if (busy && busy < MAX_BUSY) {
          appendRecord(dp.acks(run.runId), { seq: r.seq, key: r.key, busy, message, at: iso(now()) });
          return { ok: false, class: 'node-busy', message, importDone, sent };
        }
        appendRecord(dp.acks(run.runId), { seq: r.seq, key: r.key, refused: true, ...(busy ? { busy } : {}), message, at: iso(now()) });
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

/**
 * How to start a CLI without a shell: the override, <name>(.exe) on PATH (and `extraDirs`), or on
 * Windows the npm shim's JavaScript entry under Node (a .cmd cannot be started without a shell).
 */
function resolveCli({ override, name, npmEntry, extraDirs = [] }, env, platform) {
  if (override) return /\.(?:m?js|cjs)$/.test(override) ? { cmd: process.execPath, pre: [override] } : { cmd: override, pre: [] };
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  dirs.push(...extraDirs);
  const win = platform === 'win32';
  for (const d of dirs) {
    const exe = join(d, win ? `${name}.exe` : name);
    if (existsSync(exe)) return { cmd: exe, pre: [] };
    if (win && existsSync(join(d, `${name}.cmd`))) {
      const cli = join(d, 'node_modules', ...npmEntry);
      if (existsSync(cli)) return { cmd: process.execPath, pre: [cli] };
    }
  }
  return null;
}

/** How to start claude without a shell: an override, claude(.exe) on PATH, or the npm shim's cli.js under Node. */
export function resolveClaude(env = process.env, platform = process.platform) {
  return resolveCli({ override: env.WYBE_CONNECT_CLAUDE_BIN, name: 'claude', npmEntry: ['@anthropic-ai', 'claude-code', 'cli.js'], extraDirs: [join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local')] }, env, platform);
}

/** How to start codex without a shell: an override, codex(.exe) on PATH, or the npm shim's bin/codex.js under Node. */
export function resolveCodex(env = process.env, platform = process.platform) {
  return resolveCli({ override: env.WYBE_CONNECT_CODEX_BIN, name: 'codex', npmEntry: ['@openai', 'codex', 'bin', 'codex.js'] }, env, platform);
}

/** The plan's ranges by project, each project once, in the order its first range comes. */
function rangesByProject(transcripts) {
  const groups = new Map();
  for (const t of transcripts) {
    const name = typeof t.project === 'string' && t.project ? t.project : null;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(t);
  }
  return groups;
}

export function buildPrompt(plan) {
  const codex = harnessOf(plan) === 'codex';
  const harness = codex ? 'Codex' : 'Claude Code';
  const importing = plan.mode === 'import';
  const memory = Array.isArray(plan.memory) ? plan.memory.filter((f) => typeof f?.path === 'string') : [];
  const lines = [
    'wybe-connect distil run (started in the background by the wybe-connect plugin, not by a person).',
    `mode: ${plan.mode}`,
  ];
  if (importing) lines.push(`import_of: ${plan.importOf}`);
  lines.push('', (codex
    ? 'Read these Codex rollout ranges (one JSON event per line) with a read-only shell command that prints only those lines, e.g. `sed -n \'<first>,<last>p\' <file>`, or in PowerShell `Get-Content -LiteralPath <file> | Select-Object -Skip <first - 1> -First <count>`'
    : 'Read these transcript ranges with the Read tool (offset = the first line, limit = the number of lines)') + ', grouped by project:');
  for (const [project, ranges] of rangesByProject(plan.transcripts)) {
    if (project) lines.push(`Project ${project}:`);
    for (const t of ranges) lines.push(`- ${t.path} lines ${t.fromLine + 1}-${t.toLine}`);
  }
  if (!plan.transcripts.length) lines.push('- (none)');
  lines.push('Read only those ranges: never another transcript, nor other lines of these. What lies outside them was distilled already, and reading it again would store the same facts twice.');
  if (!codex) lines.push('A range too long to read whole: Grep a listed transcript by its own path (one file per call, never a folder) and use only the matches inside its range.');
  if (codex) {
    lines.push('In a rollout the person\'s own words are the event_msg user_message (or item_completed UserMessage) events and the answers are response_item messages with role assistant. Developer messages, AGENTS.md and <environment_context> blocks are the harness talking, not the person. Run nothing that writes or changes anything.');
  }
  if (importing) {
    lines.push('', `This is the import the person asked for in Wybe. The ranges above are every ${harness} session still on this machine that is not distilled yet, grouped by project; when there are many, the rest follow in later runs.`);
  }
  if (memory.length) {
    lines.push('', importing
      ? 'Also read these memory files whole: the person\'s standing instructions and notes about their work.'
      : 'These memory files are new or changed since they were last read; read them whole too, and use only what is new in them:');
    for (const f of memory) lines.push(`- ${f.path}`);
  }
  lines.push(
    '',
    'Then:',
    '1. Pick at most 40 durable facts about the person\'s WORK: projects, decisions and why, preferences, ways of working, tools, ideas. One short, self-contained statement per item, at most 400 characters. Work only: never secrets, credentials, code, file contents, anything personal, or anything about other people.',
    '2. For each project above, write one summary item: subject: <the project\'s name exactly as it follows "Project" above>, category: insight, content starting with "Project summary:": what the project is, the person\'s role in it, its current state, key decisions and open threads; at most 3000 characters; work only, as in step 1.' + (importing ? '' : ' In this run, write a project\'s summary only when its ranges changed something about it, and say only what changed.'),
    '3. If pending_questions has open questions this material clearly answers, add the answer as an item and pass answers: [<question id>].',
    `4. Send at most 40 facts plus one summary per project with the ${codex ? 'wybe_distil' : 'wybe'} server's remember tool, at most 50 items per call.` + (importing ? ` Pass import_of: ${plan.importOf} on the LAST remember call, and send at least one item.` : ''),
    `5. Finally call distil_done exactly once. If nothing is durable, send nothing and call distil_done.${codex ? ' Use only the wybe_distil server: never the tools of another server named wybe.' : ''}`,
  );
  return lines.join('\n');
}

/** The environment of a run's claude and its MCP server: the run, the home, and the connection the run is for. */
const runEnv = (plan, root) => ({ [DISTIL_ENV]: plan.runId, WYBE_CONNECT_HOME: wybeHomeOf(root, harnessOf(plan)), [NODE_ENV]: typeof plan.connection === 'string' ? plan.connection : '' });

/**
 * A path as the absolute path of a permission rule. Claude Code matches rule paths in POSIX form,
 * with Windows paths normalized first (C:\Users\x becomes /c/Users/x), and an absolute rule path
 * starts with `//`. gitignore's pattern characters are escaped, so the rule is that literal path.
 */
export function ruleAbsPath(path) {
  let s = String(path);
  const drive = /^([A-Za-z]):[\\/]/.exec(s);
  if (drive) s = `/${drive[1].toLowerCase()}/${s.slice(3).replace(/\\/g, '/')}`;
  return `/${s.replace(/[\\[\]*?]/g, (c) => `\\${c}`)}`;
}

/** The run's file tools: each gets the same path-scoped rules. */
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const toolRules = (rulePath) => READ_TOOLS.map((tool) => `${tool}(${rulePath})`);

/**
 * The run's read permission: for each file the plan reads (its transcripts and its memory files,
 * planMemory), one Read, one Glob and one Grep rule, never a broader one (a run that greps a parent
 * folder is refused).
 */
export function claudeReadRules(plan) {
  const memory = Array.isArray(plan.memory) ? plan.memory.filter((f) => typeof f?.path === 'string') : [];
  return [...new Set([...(plan.transcripts ?? []), ...memory].flatMap((x) => toolRules(ruleAbsPath(x.path))))];
}

/** The run's own settings (claudeArgs): no hooks, and reads of the plan's paths only. */
export function claudeSettings(plan) {
  return { disableAllHooks: true, permissions: { allow: claudeReadRules(plan) } };
}

/**
 * `claude -p` for one plan. Its file tools are Read, Glob and Grep only, and in dontAsk mode a read
 * outside the working directory is refused unless a rule allows it: the transcripts live under
 * the Claude home, so the plan's own paths are allowed one by one (claudeReadRules), never a
 * whole folder of the person's. The rules are the file `settingsFile` (claudeSettings, written by
 * runRunner), not inline JSON, so each path is on the command line once: Windows caps a command
 * line at 32767 characters. The run uses the person's Claude login but none of their settings
 * files (`--setting-sources ""`): no hooks, plugins, permission rules or MCP servers of theirs
 * load, and `disableAllHooks` holds even where a settings layer still applied. (`--bare` would
 * skip the login, and `--safe-mode` ignores `--mcp-config`, so neither fits.) Its only server is
 * the plugin's own, in distil mode. It runs in the distil's own folder (runRunner).
 */
export function claudeArgs(plan, { root, pluginRoot = PLUGIN_ROOT, settingsFile }) {
  const mcp = { mcpServers: { wybe: { command: process.execPath, args: [join(pluginRoot, 'bin', 'mcp-proxy.js')], env: runEnv(plan, root) } } };
  return [
    '-p', buildPrompt(plan),
    '--tools', 'Read,Glob,Grep',
    '--allowedTools', 'mcp__wybe__remember,mcp__wybe__distil_done,mcp__wybe__pending_questions',
    '--setting-sources', '',
    '--settings', settingsFile,
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--permission-mode', 'dontAsk',
    '--max-turns', '40',
  ];
}

// A `-c key=value` value is TOML. A JSON string or array of strings is valid TOML as it is (the
// escapes JSON writes are TOML's too); a table is written inline.
const tomlTable = (o) => `{ ${Object.entries(o).map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`).join(', ')} }`;

/**
 * `codex exec` for one plan: the read-only sandbox, JSON events to the run's log, --ephemeral so
 * the run leaves no rollout (it is never a session to import), no git-repository check, no hooks
 * (`features.hooks=false`: none of the person's user, project or plugin hooks run in it), and as its
 * only MCP server the plugin's own, in distil mode. `mcp_servers={}` first drops every server the
 * person configured; Codex starts a stdio server with only a few variables of its own environment
 * plus the server's `env` table, so the distil mode is carried there. It is named wybe_distil, not
 * wybe, so it can never be confused with the plugin's own interactive server. The prompt goes last.
 */
export function codexArgs(plan, { root, pluginRoot = PLUGIN_ROOT }) {
  return [
    'exec',
    '--sandbox', 'read-only',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '-c', 'features.hooks=false',
    '-c', 'mcp_servers={}',
    '-c', `mcp_servers.wybe_distil.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.wybe_distil.args=${JSON.stringify([join(pluginRoot, 'bin', 'mcp-proxy.js')])}`,
    '-c', `mcp_servers.wybe_distil.env=${tomlTable(runEnv(plan, root))}`,
    buildPrompt(plan),
  ];
}

const RUNNERS = {
  'claude-code': { name: 'claude', missing: 'claude-missing', args: claudeArgs, settings: claudeSettings, resolve: () => resolveClaude() },
  codex: { name: 'codex', missing: 'codex-missing', args: codexArgs, resolve: () => resolveCodex() },
};

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

function runRunner(plan, { root, resolve, spawnImpl, runTimeoutMs, logFile, cwd, settingsFile }) {
  const runner = RUNNERS[harnessOf(plan)];
  const how = resolve();
  if (!how) return Promise.resolve({ code: null, error: runner.missing });
  if (runner.settings) {
    try {
      // never mkdir: a connection removed meanwhile must not get its folder back
      writeFileSync(settingsFile, JSON.stringify(runner.settings(plan)), { mode: 0o600 });
    } catch (err) {
      return Promise.resolve({ code: null, error: `could not start ${runner.name}: ${err?.code ?? err}` });
    }
  }
  const dropSettings = () => { if (runner.settings) unlinkAll([settingsFile]); };
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
      // The run is in the distil's own folder: no project's AGENTS.md, CLAUDE.md or settings apply
      // to it, and its working directory (readable without a rule) is never a project of the person's.
      child = spawnImpl(how.cmd, [...how.pre, ...runner.args(plan, { root, settingsFile })], { stdio: ['ignore', io, io], windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, ...runEnv(plan, root) }, cwd });
    } catch (err) {
      if (fd !== null) closeSync(fd);
      dropSettings();
      done({ code: null, error: `could not start ${runner.name}: ${err?.code ?? err}` });
      return;
    }
    const timer = setTimeout(() => killTree(child.pid), runTimeoutMs);
    const end = (code, error = null) => {
      clearTimeout(timer);
      if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
      dropSettings();
      done({ code, error });
    };
    child.on('error', (err) => end(null, `could not start ${runner.name}: ${err?.code ?? err}`));
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
export async function runWatchdog(planFile, { paths: p, now = Date.now, resolve = null, spawnImpl = defaultSpawn, fetchImpl = globalThis.fetch, timeoutMs = DELIVERY_TIMEOUT_MS, runTimeoutMs = RUN_TIMEOUT_MS } = {}) {
  const plan = readJson(planFile);
  if (!plan?.runId) return { ok: false, outcome: 'no-plan' };
  const runner = RUNNERS[harnessOf(plan)];
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
    const exit = await runRunner(plan, { root: p.root, resolve: resolve ?? runner.resolve, spawnImpl, runTimeoutMs, logFile: distilPaths(p).log(plan.runId), cwd: distilPaths(p).dir, settingsFile: distilPaths(p).settings(plan.runId) });
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
      const missing = exit.error === runner.missing;
      const cls = missing ? runner.missing : 'distil-failed';
      const why = missing ? `${runner.name} was not found on this machine` : `${verdict.reason}${exit.code ? ` (${runner.name} exited ${exit.code})` : ''}`;
      returnToPending(s, s.running.transcripts);
      returnMemory(s, s.running);
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
      // again would only send them twice. The person is told.
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
  'signed-out': (label) => `this ${label} is no longer signed in to the colleague; the distilled work facts wait on this machine. Call the wybe server's \`connect\` tool to sign in again`,
  'distil-failed': 'the background distil did not finish; it runs again in 30 minutes',
  'claude-missing': 'the background distil could not find the claude command on this machine',
  'codex-missing': 'the background distil could not find the codex command on this machine',
  'import-unconfirmed': 'the import was sent, but the colleague did not confirm it',
  'node-busy': 'the colleague could not take more work facts right now (its limit for the day, or too many at once), so they wait on this machine and are sent again later (every 30 minutes)',
};

const noticeOf = (cls, label) => {
  const n = NOTICES[cls];
  return typeof n === 'function' ? n(label) : n ?? 'the background distil had a problem';
};

/** One line for SessionStart about a delivery problem or dropped notes, told once per kind. Null when there is nothing new. */
export function distilNotice(p, { now = Date.now(), harness = 'claude-code' } = {}) {
  const label = harness === 'codex' ? 'Codex' : 'Claude Code';
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
        parts.push(`${n} batch${n === 1 ? '' : 'es'} of distilled work facts ${n === 1 ? 'was' : 'were'} made for another colleague than the one this ${label} is connected to now; ${n === 1 ? 'it is' : 'they are'} kept on this machine and sent only to that colleague, if this ${label} connects to it again`);
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
        parts.push(`${noticeOf(s.lastError.class, label)} (${s.lastError.message})`);
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
