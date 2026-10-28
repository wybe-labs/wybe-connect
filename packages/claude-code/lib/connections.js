// Several connections per harness: one per node (or per account, with a name of its own), each a
// separate pairing with its own grant, queue and question cache, so data meant for one node can
// never be drained to another. Layout under a harness home (lib/home.js harnessHome):
//   connections.json                    { version: 1, recent: [<name>, ...] }, most recently used first
//   connections/<name>/credentials.json the grant (same shape as the old single credentials.json)
//   connections/<name>/queue/           payloads this node has not taken yet
//   connections/<name>/open-questions.json, surfaced-questions.json
//   state/sessions/<session>.json       { connection } the connection a session uses, fixed at its first hook
//   state/<transcript-id>.json, spool/  shared: a transcript belongs to one session
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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
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

/** Fixes a session to a connection and the node it is for, so a name reused later does not move it. */
function pin(root, sessionId, key, { moved = false } = {}) {
  const nodeUrl = key ? readGrant(connectionPaths(root, key))?.nodeUrl ?? null : null;
  writeJsonPrivate(pinPath(root, sessionId), { connection: key, nodeUrl, ...(moved ? { moved: true } : {}) });
}

/**
 * Whether a session was sent by `use --session` (its pin says moved) to a connection that still exists and
 * is not `key`: a call that names no session could then be that session's, bound for another node. A move
 * to a removed connection, or to `key` itself, leaves nothing to tell apart.
 */
export function sessionMovedElsewhere(root, key) {
  const dir = join(root, 'state', 'sessions');
  if (!existsSync(dir)) return false;
  const known = knownKeys(root);
  return readdirSync(dir).some((f) => {
    if (!f.endsWith('.json')) return false;
    const p = readJson(join(dir, f));
    return p?.moved === true && typeof p.connection === 'string' && p.connection !== key && known.includes(p.connection);
  });
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
 * Deletes the local grant and what is queued for it. The pairing on the node stays until revoked there. A move
 * to it ends with it: those sessions' pins go, so a connection added again under the name does not bring back a
 * move that refuses every session naming none.
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
      if (p?.moved === true && p.connection === key) rmSync(join(dir, f), { force: true });
    }
  }
  return { key, dropped };
}

/** The connection a session is fixed to: a name, null (fixed to none), or undefined while it is not fixed. */
export function pinnedConnection(root, sessionId) {
  const pinned = readJson(pinPath(root, sessionId));
  return pinned && 'connection' in pinned ? pinned.connection : undefined;
}

/** The names of every connection in this home. */
export function connectionNames(root) {
  migrateLegacy(root);
  return knownKeys(root);
}

/** The connection this session uses (see the order at the top), fixed for the session on first call. */
export function resolveSession(root, { sessionId = null, env = process.env } = {}) {
  migrateLegacy(root);
  const known = knownKeys(root);
  if (sessionId) {
    const pinned = readJson(pinPath(root, sessionId));
    if (pinned && 'connection' in pinned) {
      const key = pinned.connection;
      if (typeof key !== 'string' || !known.includes(key)) return null;
      const now = readGrant(connectionPaths(root, key));
      return now && typeof pinned.nodeUrl === 'string' && originOf(now.nodeUrl) === originOf(pinned.nodeUrl) ? key : null;
    }
  }
  const wanted = env[NODE_ENV];
  const key = wanted ? findConnection(root, wanted) : defaultConnection(root);
  // an unknown WYBE_CONNECT_NODE is pinned too: that session stays unconnected, never on another node
  if (sessionId && (key || wanted)) pin(root, sessionId, key);
  return key;
}

/**
 * A line for the SessionStart context: this session's id whenever it has one (a connection added later, and a
 * move of another session, then need it in every call), and the other connections when there are any; else null.
 * `command` is how to run this harness's bin/connect.js.
 */
export function sessionNote(root, key, { sessionId = null, command }) {
  const others = knownKeys(root).filter((k) => k !== key);
  if (!key || (!others.length && !sessionId)) return null;
  if (!others.length) return `This session sends to the connection ${key}; its session_id is ${sessionId}.`;
  const how = sessionId ? ` If the person asks to send this session to another one, run: ${command} use <name> --session ${sessionId}` : '';
  return `This session sends to the connection ${key}; the person is also connected to ${others.join(', ')}.${how}`;
}

/** The paths for this session's connection; credentials, queue and caches are null when it has none. */
export function sessionPaths(root, opts = {}) {
  const key = resolveSession(root, opts);
  if (key) return connectionPaths(root, key);
  return { ...legacyPaths(root), connection: null, credentials: null, queue: null, openQuestions: null, surfacedQuestions: null };
}
