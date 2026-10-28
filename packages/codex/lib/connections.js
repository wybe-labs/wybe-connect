// Several connections per harness: one per node (or per account, with a name of its own), each a
// separate pairing with its own grant, queue and question cache, so data meant for one node can
// never be drained to another. Layout under a harness home (lib/home.js harnessHome):
//   connections.json                    { version: 1, recent: [<name>, ...] }, most recently used first
//   connections/<name>/credentials.json the grant (same shape as the old single credentials.json)
//   connections/<name>/queue/           payloads this node has not taken yet
//   connections/<name>/open-questions.json, surfaced-questions.json
//   connections/<name>/spool/           Cursor records written while a conversation used this connection
//   state/sessions/<session>.json       { connection, nodeUrl, moved?, transcriptPath?, segments } the connection a
//                                       session uses, fixed at its first hook; segments [{ connection, nodeUrl,
//                                       fromLine }] say which node each of its transcript's lines belongs to
// A session is the harness's session_id as the hook receives it: /clear gives a new one (a new session), /resume
// keeps it (test/fixtures/claude-code-session-start.jsonl, a real SessionStart input with source "resume").
//   state/<transcript-id>.json          shared: a transcript belongs to one session
// <name> is the node's host (dittfirma.wybe.me; a port becomes _8443) unless connect was given --name.
//
// Which connection a session uses, first match wins:
//   1. the one the session already uses (its first hook fixed it; `connect use --session` changes it)
//   2. WYBE_CONNECT_NODE (a name, host or URL) in the harness's environment; unknown means none,
//      never another node
//   3. the default: the most recently connected or `use`d one, or the only one
// A session is fixed to a connection and its node: when that connection is removed, or its name
// is reused for another node, the session stays unconnected rather than move. A name another node
// holds is refused at connect, so a grant and its queue never pass from one node to another.
//
// The old single <home>/credentials.json (with its queue and caches) moves under its node on the
// first call that reads the store; when that node already has a connection the old file is left
// where it is, untouched. One that is not a grant (bad JSON or shape) is renamed
// credentials.unreadable.json; one that fails to read (busy, locked) stays for the next call.

import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { paths as legacyPaths, readJson, writeJsonPrivate, loadCredentials, saveCredentials } from './home.js';

export const NODE_ENV = 'WYBE_CONNECT_NODE';
const MAX_NAME = 120;
// no trailing dot: Windows drops it, so "foo." would be the directory "foo"
const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,118}[a-z0-9_-])?$/;

const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
const indexPath = (root) => join(root, 'connections.json');
const pinPath = (root, sessionId) => join(root, 'state', 'sessions', `${safeId(sessionId)}.json`);
const originOf = (url) => new URL(url).origin;

/** The node's host as a directory name: IPv6 brackets and the port separator become _, and a host too long for one keeps a hash. */
export function connectionKey(nodeUrl) {
  const host = new URL(nodeUrl).host.toLowerCase().replace(/\.(?=$|:)/g, '');
  const key = host.replace(/[^a-z0-9._-]/g, '_').replace(/^[^a-z0-9]+|[^a-z0-9_-]+$/g, '');
  if (key.length <= MAX_NAME) return key;
  return `${key.slice(0, MAX_NAME - 13)}-${createHash('sha256').update(host).digest('hex').slice(0, 12)}`;
}

export function checkedName(name) {
  const n = String(name ?? '').toLowerCase();
  if (!NAME_RE.test(n) || n.includes('..')) throw new Error(`bad connection name ${JSON.stringify(String(name ?? ''))}: letters, digits, dot, dash, underscore, not ending in a dot`);
  return n;
}

/** The paths object lib/flush.js and the hooks take, scoped to one connection. */
export function connectionPaths(root, key) {
  const dir = join(root, 'connections', key);
  return {
    ...legacyPaths(root),
    connection: key,
    credentials: join(dir, 'credentials.json'),
    queue: join(dir, 'queue'),
    openQuestions: join(dir, 'open-questions.json'),
    surfacedQuestions: join(dir, 'surfaced-questions.json'),
    spool: join(dir, 'spool'),
  };
}

function knownKeys(root) {
  const dir = join(root, 'connections');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((k) => NAME_RE.test(k) && existsSync(join(dir, k, 'credentials.json'))).sort();
}

function recent(root) {
  const r = readJson(indexPath(root))?.recent;
  return Array.isArray(r) ? r.filter((k) => typeof k === 'string') : [];
}

function writeRecent(root, list) {
  writeJsonPrivate(indexPath(root), { version: 1, recent: [...new Set(list)] });
}

const markRecent = (root, key) => writeRecent(root, [key, ...recent(root)]);

function moveIfThere(from, to) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function isGrant(c) {
  try {
    return Boolean(c && typeof c.nodeUrl === 'string' && originOf(c.nodeUrl));
  } catch {
    return false;
  }
}

/** The grant at `p`, or null when it is missing or unreadable (never throws). */
function readGrant(p) {
  try {
    const c = loadCredentials(p);
    return isGrant(c) ? c : null;
  } catch {
    return null;
  }
}

/** An old credentials.json that cannot be read is renamed, never deleted, so it blocks nothing. */
function setAside(root, file) {
  let target = join(root, 'credentials.unreadable.json');
  for (let i = 2; existsSync(target); i++) target = join(root, `credentials.unreadable-${i}.json`);
  moveIfThere(file, target);
}

/**
 * Moves an old single credentials.json under its node. Returns the name it got, or null. The
 * grant moves last: until it has moved, the next call redoes the whole move, so a hook killed
 * halfway strands nothing.
 */
export function migrateLegacy(root) {
  const old = legacyPaths(root);
  if (!existsSync(old.credentials)) return null;
  let credentials;
  try {
    credentials = loadCredentials(old);
  } catch (err) {
    // a read error (busy, locked, not a file) leaves the file for the next call; only one that
    // is not a grant at all (bad JSON, wrong shape) is set aside
    if (err?.code) return null;
    credentials = null;
  }
  if (!isGrant(credentials)) {
    if (existsSync(old.credentials)) setAside(root, old.credentials);
    return null;
  }
  const key = connectionKey(credentials.nodeUrl);
  const p = connectionPaths(root, key);
  if (existsSync(p.credentials)) return null;
  mkdirSync(join(root, 'connections', key), { recursive: true, mode: 0o700 });
  if (existsSync(old.queue)) {
    mkdirSync(p.queue, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(old.queue)) moveIfThere(join(old.queue, f), join(p.queue, f));
  }
  moveIfThere(old.openQuestions, p.openQuestions);
  moveIfThere(old.surfacedQuestions, p.surfacedQuestions);
  try {
    renameSync(old.credentials, p.credentials);
  } catch (err) {
    if (err?.code === 'ENOENT') return null; // another hook migrated it a moment ago
    throw err;
  }
  if (!recent(root).length) markRecent(root, key);
  return key;
}

export function defaultConnection(root) {
  migrateLegacy(root);
  const known = knownKeys(root);
  return recent(root).find((k) => known.includes(k)) ?? (known.length === 1 ? known[0] : null);
}

/** A name, a bare host or a node URL -> the connection name, or null. */
export function findConnection(root, ref) {
  migrateLegacy(root);
  const known = knownKeys(root);
  const r = String(ref ?? '').trim().toLowerCase();
  if (!r) return null;
  if (known.includes(r)) return r;
  let key = null;
  try {
    key = connectionKey(r.includes('://') ? r : `https://${r}`);
  } catch {
    return null;
  }
  return known.includes(key) ? key : null;
}

export function listConnections(root) {
  const def = defaultConnection(root);
  const order = recent(root);
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  return knownKeys(root)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((key) => {
      const p = connectionPaths(root, key);
      const c = readGrant(p) ?? { nodeUrl: '(unreadable credentials.json)', scopes: [] };
      const queued = existsSync(p.queue) ? readdirSync(p.queue).filter((f) => f.endsWith('.json')).length : 0;
      return { key, nodeUrl: c.nodeUrl, scopes: c.scopes, connectedAt: c.connectedAt ?? null, queued, isDefault: key === def };
    });
}

/**
 * The name a grant for `nodeUrl` would be stored under. Refuses a name another node already
 * holds: overwriting it would hand that node's queue to this one. The same node again is fine.
 */
export function checkSave(root, nodeUrl, name = null) {
  migrateLegacy(root);
  const key = name === null ? connectionKey(nodeUrl) : checkedName(name);
  const held = readGrant(connectionPaths(root, key));
  if (held && originOf(held.nodeUrl) !== originOf(nodeUrl)) {
    throw new Error(`connection ${key} is ${held.nodeUrl}; remove it first or choose another --name`);
  }
  return key;
}

/**
 * Stores a grant from oauth.connect() as its own connection and makes it the default. Each save
 * gets a new random grantId, so a flush still running on the grant it replaces can tell (lib/flush.js).
 */
export function saveConnection(root, credentials, { name = null } = {}) {
  const key = checkSave(root, credentials.nodeUrl, name);
  saveCredentials({ ...credentials, grantId: randomBytes(16).toString('hex') }, connectionPaths(root, key));
  markRecent(root, key);
  return key;
}

/** Lines in a transcript file (a line is written whole, so the count is a line boundary), or null when it cannot be read. */
function linesIn(path) {
  try {
    const buf = readFileSync(path);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n += 1;
    return n;
  } catch {
    return null;
  }
}

/** A pin's segments, oldest first: [{ connection, nodeUrl, fromLine }]. A pin written before segments is one, from line 0. */
function segmentsOf(pinned) {
  if (!pinned || !('connection' in pinned)) return [];
  if (!Array.isArray(pinned.segments)) return [{ connection: pinned.connection, nodeUrl: pinned.nodeUrl ?? null, fromLine: 0 }];
  return pinned.segments.filter((s) => s && typeof s === 'object' && Number.isInteger(s.fromLine) && s.fromLine >= 0);
}

/**
 * Fixes a session to a connection and the node it is for, so a name reused later does not move it. A move starts a
 * segment at the transcript's line count: the lines before it stay with the connection the session was on.
 */
function pin(root, sessionId, key, { moved = false, transcriptPath = null, pendingTranscript = null } = {}) {
  const nodeUrl = key ? readGrant(connectionPaths(root, key))?.nodeUrl ?? null : null;
  const was = readJson(pinPath(root, sessionId));
  const pending = pendingTranscript ?? (typeof was?.pendingTranscript === 'string' ? was.pendingTranscript : null);
  // A transcript that was not written yet when its path was first given counts once it exists.
  const path = transcriptPath ?? (typeof was?.transcriptPath === 'string' ? was.transcriptPath : null) ?? existingTranscript(pending);
  // seenAt is when a hook last resolved the pin (prunePins), or when the person moved this session to a connection: a
  // move is their choice for it now. A remove rewrites other pins without renewing them.
  const seenAt = !moved && Number.isFinite(was?.seenAt) ? was.seenAt : Date.now();
  let segments = segmentsOf(was);
  const last = segments[segments.length - 1];
  if (!last || last.connection !== key || last.nodeUrl !== nodeUrl) {
    // A first stay starts at line 0, so lines written before any connection existed go to the first one: the one
    // exception to "each line goes to the node it was written on", since no node had them (the first-run import).
    const fromLine = last && path ? linesIn(path) ?? last.fromLine : 0;
    if (last && last.fromLine >= fromLine) segments = segments.filter((s) => s.fromLine < fromLine);
    segments = [...segments, { connection: key, nodeUrl, fromLine }];
  }
  writeJsonPrivate(pinPath(root, sessionId), { connection: key, nodeUrl, ...(moved ? { moved: true } : {}), ...(path ? { transcriptPath: path } : pending ? { pendingTranscript: pending } : {}), seenAt, ...(was?.written === true ? { written: true } : {}), segments });
}

/**
 * Where a stored pin sends: its connection while that still exists for the node it was pinned with, else null
 * (pinned to none, removed, or the name now holds another node). The one reading of a pin: the hooks, the
 * MCP server and distil all go through it.
 */
function livePin(root, pinned) {
  const key = pinned.connection;
  if (typeof key !== 'string' || !knownKeys(root).includes(key)) return null;
  const now = readGrant(connectionPaths(root, key));
  return now && typeof pinned.nodeUrl === 'string' && originOf(now.nodeUrl) === originOf(pinned.nodeUrl) ? key : null;
}

/**
 * Whether a moved session's earlier lines follow it to the connection it moves to. They stay: each line goes to the
 * node the session was on when it was written. Flipping this gives a later segment every line from 0 instead.
 */
const EARLIER_LINES_FOLLOW_A_MOVE = false;

/**
 * The lines of a session's transcript that belong to connection `key`: [[fromLine, toLine]] per segment the session
 * spent there while `key` still holds that segment's node (toLine null: still open), oldest first. Null while the
 * session is not fixed (its lines are the person's, for any connection). A removed connection's lines go nowhere.
 */
export function sessionLines(root, sessionId, key) {
  if (!sessionId) return null;
  const pinned = readJson(pinPath(root, sessionId));
  if (!pinned || !('connection' in pinned)) return null;
  const segments = segmentsOf(pinned);
  const out = [];
  segments.forEach((s, i) => {
    if (livePin(root, s) !== key) return;
    out.push([EARLIER_LINES_FOLLOW_A_MOVE && i > 0 ? 0 : s.fromLine, i + 1 < segments.length ? segments[i + 1].fromLine : null]);
  });
  return out;
}

/**
 * Only a transcript that exists counts as the pin's transcript: one not written yet must not get its session's pin
 * pruned (prunePins). Its path is kept as pendingTranscript, so a move before the first hook that sees the file still
 * counts its lines.
 */
function existingTranscript(path) {
  return typeof path === 'string' && path && existsSync(path) ? path : null;
}
const givenPath = (path) => (typeof path === 'string' && path ? path : null);

/** Keeps a fixed session's transcript in its pin (a hook's input, or a distil note), so a move can count its lines. */
export function recordTranscript(root, sessionId, transcriptPath) {
  if (!sessionId) return;
  const was = readJson(pinPath(root, sessionId));
  if (!was || !('connection' in was)) return;
  const path = existingTranscript(transcriptPath);
  if (path && was.transcriptPath !== path) {
    const { pendingTranscript, ...rest } = was;
    writeJsonPrivate(pinPath(root, sessionId), { ...rest, transcriptPath: path });
  } else if (!path && givenPath(transcriptPath) && typeof was.transcriptPath !== 'string' && typeof was.pendingTranscript !== 'string') {
    writeJsonPrivate(pinPath(root, sessionId), { ...was, pendingTranscript: transcriptPath });
  }
}

/** The connection a session sends to by its pin (see pinnedConnection) and its transcript as a hook gave it, or nulls. */
export function sessionTranscript(root, sessionId) {
  const pinned = sessionId ? readJson(pinPath(root, sessionId)) : null;
  return {
    connection: pinned && 'connection' in pinned ? livePin(root, pinned) : null,
    transcriptPath: typeof pinned?.transcriptPath === 'string' ? pinned.transcriptPath : existingTranscript(pinned?.pendingTranscript),
  };
}

/**
 * Whether a call must say which session it is: always with two or more connections, and with one while any
 * session's pin sends elsewhere (to none, or to a name no longer here). A call that named no session could then be
 * that session's, and it must never reach the one connection left. With one connection and every pin on it, no.
 */
export function sessionIdRequired(root) {
  const names = knownKeys(root);
  if (names.length !== 1) return names.length > 1;
  const dir = join(root, 'state', 'sessions');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => {
    if (!f.endsWith('.json')) return false;
    const p = readJson(join(dir, f));
    return !!p && 'connection' in p && livePin(root, p) !== names[0];
  });
}

/** How long a pin with no known transcript outlives the last hook that resolved it: the grace for a session that has not written a line yet. */
export const PIN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Marks a session as having written, for a harness with no transcript (Cursor spools its records): from then on its pin
 * is not timed, so a move or a pin to none holds however long the conversation is idle.
 */
export function markWritten(root, sessionId) {
  if (!sessionId) return;
  const was = readJson(pinPath(root, sessionId));
  if (was && 'connection' in was && was.written !== true) writeJsonPrivate(pinPath(root, sessionId), { ...was, written: true });
}

/**
 * How long a written pin with no transcript (Cursor) outlives the last hook that resolved it: a conversation idle this
 * long is over, and its pin must not keep id-less calls refused (sessionIdRequired) for good.
 */
export const WRITTEN_PIN_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deletes the pins whose transcript is gone (a pin lives as long as its transcript; a pending one counts once it
 * exists). One with no transcript is timed by PIN_GRACE_MS until it has written, the grace for a session that has not
 * written a line yet, and by WRITTEN_PIN_IDLE_MS after: both from the last hook that resolved it (seenAt; a pin written
 * before it has its file's time).
 */
export function prunePins(root, now = Date.now()) {
  const dir = join(root, 'state', 'sessions');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = join(dir, f);
    const p = readJson(file);
    const seen = Number.isFinite(p?.seenAt) ? p.seenAt : statSync(file).mtimeMs;
    const transcript = typeof p?.transcriptPath === 'string' ? p.transcriptPath : existingTranscript(p?.pendingTranscript);
    const gone = transcript ? !existsSync(transcript) : now - seen > (p?.written === true ? WRITTEN_PIN_IDLE_MS : PIN_GRACE_MS);
    if (gone) rmSync(file, { force: true });
  }
}

function mustFind(root, ref) {
  const key = findConnection(root, ref);
  if (!key) throw new Error(`no connection named ${ref}`);
  return key;
}

/** Without a session: the default for new sessions. With one: that session only. */
export function useConnection(root, ref, { sessionId = null } = {}) {
  const key = mustFind(root, ref);
  if (sessionId) pin(root, sessionId, key, { moved: true });
  else markRecent(root, key);
  return key;
}

/**
 * Deletes the local grant and what is queued for it. The pairing on the node stays until revoked there. A pin is
 * never deleted: a session on it is pinned to none, so it sends nowhere until the person chooses a connection
 * with `use <name> --session <id>`, never to the default or to a connection added again under the name. A
 * session's lines from its time on the removed connection go nowhere, the same way.
 */
export function removeConnection(root, ref) {
  const key = mustFind(root, ref);
  const dropped = listConnections(root).find((c) => c.key === key)?.queued ?? 0;
  rmSync(join(root, 'connections', key), { recursive: true, force: true });
  writeRecent(root, recent(root).filter((k) => k !== key));
  const dir = join(root, 'state', 'sessions');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = readJson(join(dir, f));
      if (!p || !('connection' in p)) continue;
      const segments = segmentsOf(p).map((s) => (s.connection === key ? { connection: null, nodeUrl: null, fromLine: s.fromLine } : s));
      const top = p.connection === key ? { connection: null, nodeUrl: null } : { connection: p.connection, nodeUrl: p.nodeUrl ?? null };
      writeJsonPrivate(join(dir, f), { ...p, ...top, segments });
    }
  }
  return { key, dropped };
}

/**
 * The connection a session sends to by its pin: a name, null (fixed to none, see livePin), or undefined while it
 * is not fixed.
 */
export function pinnedConnection(root, sessionId) {
  if (!sessionId) return undefined;
  const pinned = readJson(pinPath(root, sessionId));
  return pinned && 'connection' in pinned ? livePin(root, pinned) : undefined;
}

/** The names of every connection in this home. */
export function connectionNames(root) {
  migrateLegacy(root);
  return knownKeys(root);
}

/**
 * The connection a session uses (see the order at the top), without fixing it: its pin, else where a new session
 * goes. The MCP server reads this; it never writes a pin, since it knows no transcript.
 */
export function sessionConnection(root, { sessionId = null, env = process.env } = {}) {
  migrateLegacy(root);
  const pinned = pinnedConnection(root, sessionId);
  if (pinned !== undefined) return pinned;
  const wanted = env[NODE_ENV];
  return wanted ? findConnection(root, wanted) : defaultConnection(root);
}

/**
 * The connection this session uses, fixed for the session on a hook's first call. A hook passes the session's
 * transcript, which the pin keeps: a move counts its lines, and the pin lives as long as it does. A pin with no
 * transcript yet has its time renewed, so prunePins keeps it while hooks still resolve it.
 */
export function resolveSession(root, { sessionId = null, env = process.env, transcriptPath = null } = {}) {
  const transcript = existingTranscript(transcriptPath);
  const key = sessionConnection(root, { sessionId, env });
  const was = sessionId ? readJson(pinPath(root, sessionId)) : null;
  if (was && 'connection' in was) {
    recordTranscript(root, sessionId, transcriptPath);
    const now = readJson(pinPath(root, sessionId));
    if (now && typeof now.transcriptPath !== 'string') writeJsonPrivate(pinPath(root, sessionId), { ...now, seenAt: Date.now() });
    return key;
  }
  // an unknown WYBE_CONNECT_NODE is pinned too: that session stays unconnected, never on another node
  if (sessionId && (key || env[NODE_ENV])) pin(root, sessionId, key, { transcriptPath: transcript, pendingTranscript: transcript ? null : givenPath(transcriptPath) });
  return key;
}

/**
 * A line for the SessionStart context: this session's id whenever it has one, connected or not (a connection added
 * later, and a move of another session, then need it in every call), and the other connections when there are any;
 * else null. `command` is how to run this harness's bin/connect.js.
 */
export function sessionNote(root, key, { sessionId = null, command }) {
  const others = knownKeys(root).filter((k) => k !== key);
  if (!key && sessionId && pinnedConnection(root, sessionId) === null) {
    return `This session sends to no connection; its session_id is ${sessionId}. Nothing is sent until the person chooses one; to do so, run: ${command} use <name> --session ${sessionId}`;
  }
  if (!key && sessionId) return `This session is not connected yet; its session_id is ${sessionId}.`;
  if (!key || (!others.length && !sessionId)) return null;
  if (!others.length) return `This session sends to the connection ${key}; its session_id is ${sessionId}.`;
  if (!sessionId) return `This session sends to the connection ${key}; the person is also connected to ${others.join(', ')}.`;
  return `This session sends to the connection ${key}; the person is also connected to ${others.join(', ')}. Its session_id is ${sessionId}: pass it as session_id in every Wybe tool call. If the person asks to send this session to another one, run: ${command} use <name> --session ${sessionId}`;
}

/** The paths for this session's connection; credentials, queue and caches are null when it has none. */
export function sessionPaths(root, opts = {}) {
  const key = resolveSession(root, opts);
  if (key) return connectionPaths(root, key);
  return { ...legacyPaths(root), connection: null, credentials: null, queue: null, openQuestions: null, surfacedQuestions: null };
}
