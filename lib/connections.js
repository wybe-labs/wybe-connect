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
// One address can serve several colleagues, the one chosen at sign-in named in the access token (oauth.js
// colleagueOf): each colleague there gets <host>~<colleague> (colleagueKey), and a name never passes from
// one colleague to another. A connection made under the host's own name keeps it. A refused grant under the host's
// own name that names no colleague (made before colleagues were named) is taken over in place, with its sessions, by
// the first colleague signed in there, as a reconnect always did: only under its own harness account (or when it
// recorded none) and only while no connection at the address names a colleague, so it passes to one colleague only.
// A grant keeps the harness account it was made under (harnessAccount, lib/session-info.js accountOf).
// A second harness account on a node that already has a connection gets <host>~<short account hash>
// (accountKey), so the first account's grant is never replaced; the name never carries the account.
// A grant made before accounts were recorded carries none, and only a sign-in under an account marks one.
// A grant the authorization server refused for good (home.js isRefused): a sign-in to its node under the same
// harness account (or onto one that recorded none) takes its name over, and one that lands on another connection
// of that node and account moves the sessions fixed to the refused one along, so a reconnect brings every open
// session back. Another account's connection, refused or not, is never replaced by a name chosen automatically and
// its sessions never move. What the person names (use, remove, connect --name, WYBE_CONNECT_NODE) is acted on whichever
// harness account recorded it: one computer account is one person, under any of their harness logins.
//
// Which connection a session uses, first match wins:
//   1. the one the session already uses (its first hook fixed it; `connect use --session` changes it)
//   2. WYBE_CONNECT_NODE (a name, host or URL) in the harness's environment; unknown means none,
//      never another node
//   3. the most recently used connection made under the harness account the session runs under; when it has
//      none and the default is another account's, the default node's connection made before accounts were recorded
//   4. the default: the most recently connected or `use`d one, or the only one
// A session is fixed to a connection and its node: when that connection is removed, or its name
// is reused for another node, the session stays unconnected rather than move. A name another node
// holds is refused at connect, so a grant and its queue never pass from one node to another.
//
// The old single <home>/credentials.json (with its queue and caches) moves under its node on the
// first call that reads the store; when that node already has a connection the old file is left
// where it is, untouched. One that is not a grant (bad JSON or shape) is renamed
// credentials.unreadable.json; one that fails to read (busy, locked) stays for the next call.

import { basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { paths as legacyPaths, readJson, writeJsonPrivate, loadCredentials, saveCredentials, isRefused } from './home.js';
import { rolloutSessionIds } from './codex-rollout.js';
import { colleagueOf } from './oauth.js';
import { acquire } from './lock.js';

export const NODE_ENV = 'WYBE_CONNECT_NODE';
const MAX_NAME = 120;
// no trailing dot: Windows drops it, so "foo." would be the directory "foo"; ~ joins a host and a colleague or an account hash
const NAME_RE = /^[a-z0-9](?:[a-z0-9._~-]{0,118}[a-z0-9_-])?$/;
const ACCOUNT_HASH = 8;
// A save holds the connection store's lock for milliseconds: a holder older than this is gone (its pid reused).
const STORE_HOLD_MS = 60_000;
const COLLEAGUE_MAX = 40;

const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
const indexPath = (root) => join(root, 'connections.json');
const pinPath = (root, sessionId) => join(root, 'state', 'sessions', `${safeId(sessionId)}.json`);
const originOf = (url) => new URL(url).origin;
/** A harness account as compared: an e-mail without case or surrounding space; null when there is none. */
const accountId = (a) => (typeof a === 'string' && a.trim() ? a.trim().toLowerCase() : null);

/** The node's host as a directory name: IPv6 brackets and the port separator become _, and a host too long for one keeps a hash. */
export function connectionKey(nodeUrl) {
  const host = new URL(nodeUrl).host.toLowerCase().replace(/\.(?=$|:)/g, '');
  const key = host.replace(/[^a-z0-9._-]/g, '_').replace(/^[^a-z0-9]+|[^a-z0-9_-]+$/g, '');
  if (key.length <= MAX_NAME) return key;
  return `${key.slice(0, MAX_NAME - 13)}-${createHash('sha256').update(host).digest('hex').slice(0, 12)}`;
}

/**
 * `<host>~<colleague>`: the name of a connection to `colleague` on the address `nodeUrl`. An id that is
 * not already a plain lowercase name (or is too long) keeps a short hash of itself, so two ids never
 * share a name.
 */
export function colleagueName(nodeUrl, colleague) {
  const id = String(colleague);
  let slug = id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, COLLEAGUE_MAX);
  if (slug !== id) {
    const hash = createHash('sha256').update(id).digest('hex').slice(0, ACCOUNT_HASH);
    const head = slug.slice(0, COLLEAGUE_MAX - ACCOUNT_HASH - 1).replace(/-+$/, '');
    slug = head ? `${head}-${hash}` : hash;
  }
  return `${connectionKey(nodeUrl).slice(0, MAX_NAME - slug.length - 1)}~${slug}`;
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

/**
 * The grant of connection `key`, or null when it has none. One that is there but cannot be read or parsed now (cut
 * short, or held open elsewhere) is refused rather than taken for none: whose it is, and so who may write over it,
 * move or remove it, is not known.
 */
function grantOrRefuse(root, key) {
  const p = connectionPaths(root, key);
  if (!existsSync(p.credentials)) return null;
  let c;
  try {
    c = loadCredentials(p);
    if (c === null && !existsSync(p.credentials)) return null; // removed meanwhile; a file holding null is unreadable
  } catch {
    c = undefined;
  }
  if (isGrant(c)) return c;
  throw Object.assign(new Error(`can't read connection ${key} right now (${p.credentials}); try again in a moment. If it stays unreadable, remove the folder ${join(root, 'connections', key)} yourself`), { code: 'EUNREADABLE', connection: key });
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

/** A ref as a connection's own name: the name itself, or the host name a bare host or node URL gives; null when neither. */
function namedConnection(known, ref) {
  const r = String(ref ?? '').trim().toLowerCase();
  if (!r) return null;
  if (known.includes(r)) return r;
  try {
    const key = connectionKey(r.includes('://') ? r : `https://${r}`);
    return known.includes(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * A name, a bare host or a node URL -> the connection of that name, or null. Never "the only one left" at a host: a
 * session (WYBE_CONNECT_NODE) must not reach another colleague's or another account's grant because its own was removed.
 */
export function findConnection(root, ref) {
  migrateLegacy(root);
  return namedConnection(knownKeys(root), ref);
}

/**
 * For `use` and `remove`: { key } for the connection findConnection names (a bare host names only the one under the
 * host's own name), else { choices: [names] } of the connections at that host, for the person to pick one by its full
 * name, else null. Never "the only one left": that could be another colleague's or another account's.
 */
function lookupConnection(root, ref) {
  migrateLegacy(root);
  const known = knownKeys(root);
  const named = namedConnection(known, ref);
  if (named) return { key: named };
  const r = String(ref ?? '').trim().toLowerCase();
  let key;
  try {
    key = connectionKey(r.includes('://') ? r : `https://${r}`);
  } catch {
    return null;
  }
  const there = known.filter((k) => {
    const held = readGrant(connectionPaths(root, k));
    try {
      return Boolean(held) && connectionKey(held.nodeUrl) === key;
    } catch {
      return false;
    }
  });
  return there.length ? { choices: there } : null;
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
 * With `colleague` (the new grant's, or null for none), a name holding another colleague of that
 * address is refused the same way. With `account` (the new grant's harness account, or null for none),
 * a name chosen for it (not `named`: given by the person with --name) holding a grant recorded under another account
 * is refused, refused or not: its queue and sessions are that account's. A name the person gave is theirs to replace,
 * whichever account recorded it. With `account`, a name whose grant cannot be read now is refused (grantOrRefuse).
 */
export function checkSave(root, nodeUrl, name = null, { colleague, account, named = false } = {}) {
  migrateLegacy(root);
  const key = name === null ? connectionKey(nodeUrl) : checkedName(name);
  const dir = join(root, 'connections', key);
  if (existsSync(dir)) {
    // a short (8.3) alias of another connection's directory opens that directory, not one of its own
    let real = key;
    try {
      real = basename(realpathSync.native(dir)).toLowerCase();
    } catch {
      // unreadable: the grant read below decides
    }
    if (real !== key) throw new Error(`bad connection name ${key}: on this system it opens another connection (${real}); choose another --name`);
  }
  const held = account === undefined ? readGrant(connectionPaths(root, key)) : grantOrRefuse(root, key);
  if (held && originOf(held.nodeUrl) !== originOf(nodeUrl)) {
    throw new Error(`connection ${key} is ${held.nodeUrl}; remove it first or choose another --name`);
  }
  if (held && account !== undefined && !named) {
    const theirs = accountId(held.harnessAccount);
    if (theirs !== null && theirs !== accountId(account)) {
      throw Object.assign(new Error(`connection ${key} belongs to another account; choose another --name, or remove ${key} first`), { code: 'EOTHERACCOUNT', connection: key });
    }
  }
  if (held && colleague !== undefined && colleagueOf(held.accessToken) !== colleague && !(isRefused(held) && colleagueOf(held.accessToken) === null)) {
    throw new Error(`connection ${key} is another colleague at ${held.nodeUrl}; remove it first or choose another --name`);
  }
  return key;
}

/**
 * Whether connection `key` holds a grant for the node at `origin` (and, when `colleague` is given, for
 * that colleague or, with null, for none), and under which harness account.
 */
function heldFor(root, key, origin, colleague = undefined) {
  const held = readGrant(connectionPaths(root, key));
  if (!held || originOf(held.nodeUrl) !== origin) return null;
  if (colleague !== undefined && colleagueOf(held.accessToken) !== colleague) return null;
  return { account: accountId(held.harnessAccount), refused: isRefused(held) };
}

/**
 * Whether a connection to the address `nodeUrl` holds a token that names a colleague: one address then
 * serves several, and which one a sign-in gets is chosen there, so a connect signs in rather than renew.
 */
export function servesColleagues(root, nodeUrl) {
  migrateLegacy(root);
  const origin = originOf(nodeUrl);
  return knownKeys(root).some((k) => {
    const held = readGrant(connectionPaths(root, k));
    return Boolean(held) && originOf(held.nodeUrl) === origin && colleagueOf(held.accessToken) !== null;
  });
}

/**
 * The name a grant for `colleague` on the address `nodeUrl`, made under harness `account`, belongs under: this
 * colleague's connection there for that account (the most recently used first), else one of this colleague's
 * made before accounts were recorded, else colleagueName, else (taken by another account)
 * colleagueName~<short account hash>. Never another account's connection, refused or not. Without an account: this
 * colleague's connection that recorded none, else colleagueName (refused at checkSave when another account holds it).
 * Before all of these, while no connection at the address names a colleague: the connection under the host's own
 * name when its grant was refused, names no colleague and is this account's (or recorded none), taken over in place.
 */
export function colleagueKey(root, nodeUrl, colleague, account = null) {
  migrateLegacy(root);
  const origin = originOf(nodeUrl);
  const a = accountId(account);
  const host = connectionKey(nodeUrl);
  const older = heldFor(root, host, origin, null);
  if (older?.refused && (older.account === null || older.account === a) && !servesColleagues(root, nodeUrl)) return host;
  const base = colleagueName(nodeUrl, colleague);
  const order = recent(root);
  const rank = (k) => (k === base ? -1 : order.includes(k) ? order.indexOf(k) : order.length);
  const own = knownKeys(root)
    .map((k) => [k, heldFor(root, k, origin, colleague)])
    .filter(([, h]) => h)
    .sort(([x], [y]) => rank(x) - rank(y));
  const found = own.find(([, h]) => h.account === a) ?? own.find(([, h]) => h.account === null);
  if (found) return found[0];
  if (!a || !readGrant(connectionPaths(root, base))) return base;
  const hash = createHash('sha256').update(a).digest('hex').slice(0, ACCOUNT_HASH);
  return `${base.slice(0, MAX_NAME - ACCOUNT_HASH - 1)}~${hash}`;
}

/** The connections to the address `nodeUrl` whose grant was refused and was made under another harness account than `account`. */
export function refusedOfOtherAccounts(root, nodeUrl, account) {
  migrateLegacy(root);
  const origin = originOf(nodeUrl);
  const a = accountId(account);
  return knownKeys(root).filter((k) => {
    const h = heldFor(root, k, origin);
    return h?.refused && h.account !== null && h.account !== a;
  });
}

/** `<host>~<short account hash>`: the name of a second harness account's connection to `nodeUrl`. */
export function accountName(nodeUrl, account) {
  const hash = createHash('sha256').update(accountId(account) ?? '').digest('hex').slice(0, ACCOUNT_HASH);
  return `${connectionKey(nodeUrl).slice(0, MAX_NAME - ACCOUNT_HASH - 1)}~${hash}`;
}

/**
 * The name a grant for `nodeUrl` made under harness `account` belongs under: the connection this node already has
 * for that account (the most recently used first, the host's own name before others), else a connection of this node
 * whose grant was refused for good (the same order), else the host, else, when the host's connection is another
 * account's, accountName. The host's connection made before accounts were recorded is
 * renewed under its own name, since nothing tells whose it is. Without an account: the host, as before.
 */
export function accountKey(root, nodeUrl, account) {
  migrateLegacy(root);
  const base = connectionKey(nodeUrl);
  const a = accountId(account);
  if (!a) return base;
  const origin = originOf(nodeUrl);
  const order = recent(root);
  const rank = (k) => (k === base ? -1 : order.includes(k) ? order.indexOf(k) : order.length);
  const same = knownKeys(root).filter((k) => heldFor(root, k, origin)?.account === a).sort((x, y) => rank(x) - rank(y));
  if (same.length) return same[0];
  // a refused connection that recorded no account is taken over; another account's never is (checkSave)
  const refused = knownKeys(root).filter((k) => { const h = heldFor(root, k, origin); return h?.refused && h.account === null; }).sort((x, y) => rank(x) - rank(y));
  if (refused.length) return refused[0];
  const atBase = heldFor(root, base, origin);
  if (!atBase || atBase.account === null) return base;
  return accountName(nodeUrl, a);
}

/** The connection store's lock, taken around choosing a name and writing a grant; a busy store says what to do. */
function withStore(root, fn) {
  const store = join(root, 'state', 'connections.lock');
  let held;
  try {
    held = acquire(store, { maxHoldMs: STORE_HOLD_MS });
  } catch (err) {
    if (err?.code !== 'ELOCKBUSY') throw err;
    throw Object.assign(new Error(`the connection store (${join(root, 'connections')}) is busy with another connect on this computer; try again in a moment`), { code: 'ESTOREBUSY' });
  }
  try {
    return fn();
  } finally {
    held.release();
  }
}

/** Throws (ESTOREBUSY) while another connect holds the connection store: checked before a browser sign-in, so none is wasted. */
export function checkStoreFree(root) {
  withStore(root, () => {});
}

/**
 * Stores a grant from oauth.connect() as its own connection and makes it the default. Each save
 * gets a new random grantId, so a flush still running on the grant it replaces can tell (lib/flush.js).
 * Without a name, a grant whose token names a colleague goes where colleagueKey puts it, else one that
 * carries its harness account where accountKey puts it. No sign-in replaces a connection recorded under
 * another harness account, refused or not (checkSave): its queue and sessions stay that account's.
 */
export function saveConnection(root, credentials, { name = null } = {}) {
  // One save at a time per harness home: the name is chosen from what is stored, so two sign-ins finishing
  // together must not both choose the same free name and the second overwrite the first.
  return withStore(root, () => {
    const colleague = colleagueOf(credentials.accessToken);
    const auto = colleague
      ? colleagueKey(root, credentials.nodeUrl, colleague, credentials.harnessAccount)
      : credentials.harnessAccount ? accountKey(root, credentials.nodeUrl, credentials.harnessAccount) : null;
    const key = checkSave(root, credentials.nodeUrl, name ?? auto, { colleague, account: accountId(credentials.harnessAccount), named: name !== null });
    saveCredentials({ ...credentials, grantId: randomBytes(16).toString('hex') }, connectionPaths(root, key));
    moveOffRefused(root, key);
    markRecent(root, key);
    return key;
  });
}

/**
 * Moves every session fixed to a refused connection of `key`'s node and colleague (home.js isRefused) to `key`, as
 * `use <key> --session <id>` would: nothing could be sent from it on the refused one. A session whose transcript
 * cannot be counted (pin) stays where it is, for `use` once it can. One on another colleague of the address stays, and
 * so does one on a connection recorded under another harness account.
 */
function moveOffRefused(root, key) {
  const dir = join(root, 'state', 'sessions');
  const grant = readGrant(connectionPaths(root, key));
  const origin = originOf(grant.nodeUrl);
  const colleague = colleagueOf(grant.accessToken);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let pinned;
    try {
      pinned = readJson(join(dir, f));
    } catch {
      continue; // a pin that cannot be read is left as it is
    }
    const from = pinned && 'connection' in pinned ? livePin(root, pinned) : null;
    if (!from || from === key) continue;
    const was = heldFor(root, from, origin, colleague);
    if (!was?.refused) continue;
    if (was.account !== null && was.account !== accountId(grant.harnessAccount)) continue;
    try {
      pin(root, f.slice(0, -'.json'.length), key, { moved: true });
    } catch {
      // its lines cannot be counted now; the session stays until `use` moves it
    }
  }
}

/** The stored grant of connection `key`, or null. */
export function connectionGrant(root, key) {
  migrateLegacy(root);
  return readGrant(connectionPaths(root, key));
}

/**
 * Stores renewed tokens of the same grant (oauth.renewGrant) and makes it the default. The grantId
 * stays: it is the same grant, so nothing running on it is stale. Refused when the file no longer
 * holds that grant (removed or replaced meanwhile). Sessions on a refused connection of the node move to it,
 * as after a sign-in (moveOffRefused).
 */
export function renewConnection(root, key, credentials) {
  const p = connectionPaths(root, key);
  const held = readGrant(p);
  if (!held || (held.grantId ?? null) !== (credentials.grantId ?? null)) throw new Error(`connection ${key} changed meanwhile; run connect again`);
  saveCredentials(credentials, p);
  moveOffRefused(root, key);
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
  const stored = transcriptPath ?? (typeof was?.transcriptPath === 'string' ? was.transcriptPath : null) ?? existingTranscript(pending);
  const path = stored ? canonicalTranscript(stored) : null;
  let segments = segmentsOf(was);
  const last = segments[segments.length - 1];
  if (!last || last.connection !== key || last.nodeUrl !== nodeUrl) {
    // A first stay starts at line 0, so lines written before any connection existed go to the first one: the one
    // exception to "each line goes to the node it was written on", since no node had them (the first-run import).
    const counted = last && path ? linesIn(path) : null;
    if (last && path && counted === null) {
      // The transcript is not readable where the pin says: only compressed, moved into archived_sessions (plain or
      // compressed), gone, or unreadable. Its lines cannot be counted, and any guess (the previous segment's start)
      // would hand one node the other's lines. Nothing is written; resuming the session writes it out again.
      const compressed = existsSync(`${path}.zst`);
      const e = new Error(compressed
        ? `session ${sessionId} cannot move while its rollout is only compressed (${path}.zst): its lines cannot be counted. Resume the session once, then run this again.`
        : `session ${sessionId} cannot move while its transcript is not at ${path} (archived, moved or unreadable): its lines cannot be counted. Resume the session once (unarchive it first if it was archived), then run this again.`);
      e.code = compressed ? 'ETRANSCRIPTCOMPRESSED' : 'ETRANSCRIPTUNCOUNTED';
      throw e;
    }
    const fromLine = last && path ? counted : 0;
    if (last && last.fromLine >= fromLine) segments = segments.filter((s) => s.fromLine < fromLine);
    segments = [...segments, { connection: key, nodeUrl, fromLine }];
  }
  writeJsonPrivate(pinPath(root, sessionId), { connection: key, nodeUrl, ...(moved ? { moved: true } : {}), ...(path ? { transcriptPath: path } : pending ? { pendingTranscript: pending } : {}), segments });
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

/** A transcript's one spelling: a Codex rollout compressed in place (rollout-X.jsonl.zst) is still rollout-X.jsonl. */
export function canonicalTranscript(path) {
  return String(path).replace(/\.zst$/i, '');
}

/** True when `path` stats, and on doubt: only ENOENT and ENOTDIR say it is not there. */
function statsOrDoubt(path) {
  try {
    statSync(path);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR';
  }
}

/**
 * Whether a pinned session can still be resumed: its transcript is there under either spelling (plain or .zst), a
 * stat fails for another reason than "not there", or (Codex) a rollout carrying the session id is anywhere under
 * CODEX_HOME's sessions or archived_sessions (`codexIds`, from rolloutSessionIds).
 */
export function transcriptAlive(path, { sessionId = null, codexIds = null } = {}) {
  const canonical = canonicalTranscript(path);
  if (statsOrDoubt(canonical) || statsOrDoubt(`${canonical}.zst`)) return true;
  return Boolean(sessionId && codexIds?.has(String(sessionId).toLowerCase()));
}

/**
 * Only a transcript that exists (under either spelling) counts as the pin's transcript, and it is kept under its
 * canonical spelling: one not written yet must not get its session's pin pruned (prunePins). Its path is kept as
 * pendingTranscript, so a move before the first hook that sees the file still counts its lines.
 */
function existingTranscript(path) {
  if (typeof path !== 'string' || !path) return null;
  const canonical = canonicalTranscript(path);
  return existsSync(canonical) || existsSync(`${canonical}.zst`) ? canonical : null;
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
 * Pins are never pruned by time (prunePins), so a stale pin with no transcript, pinned to none or moved, keeps the id
 * required until `connect use` rewrites it. That cost is accepted: the model passes the id from its SessionStart note.
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

/**
 * Deletes the pins whose session can no longer be resumed: a pin lives while its transcript is there under either
 * spelling (a Codex rollout compressed in place, or written out again on resume), while a Codex rollout carrying its
 * session id is under `codexHome`'s sessions or archived_sessions, and on any doubt (transcriptAlive). A pending
 * transcript counts once it exists. Nothing else prunes a pin, at any age: one with no transcript file (Cursor, Codex
 * with a null transcript_path, a session that has not written yet) stays until `connect use` rewrites it, so pruning
 * never changes where a live session's lines or calls go. The session starting now (`exceptSessionId`) is never
 * pruned: its hook has just resolved it.
 */
export function prunePins(root, { exceptSessionId = null, codexHome = null } = {}) {
  const dir = join(root, 'state', 'sessions');
  if (!existsSync(dir)) return;
  const own = exceptSessionId ? `${safeId(exceptSessionId)}.json` : null;
  let codexIds = null; // read once, and only when a pin's transcript is not where it was
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === own) continue;
    const file = join(dir, f);
    const p = readJson(file);
    const transcript = typeof p?.transcriptPath === 'string' ? p.transcriptPath : existingTranscript(p?.pendingTranscript);
    if (!transcript || transcriptAlive(transcript)) continue;
    if (codexHome && !codexIds) codexIds = rolloutSessionIds(codexHome);
    if (!transcriptAlive(transcript, { sessionId: f.slice(0, -'.json'.length), codexIds })) rmSync(file, { force: true });
  }
}

function mustFind(root, ref) {
  const found = lookupConnection(root, ref);
  if (found?.choices) throw new Error(`${ref} names no connection by itself; the connections at that address are ${found.choices.join(', ')}: name one of them`);
  if (!found?.key) throw new Error(`no connection named ${ref}`);
  return found.key;
}

/**
 * Refuses connection `key` while its grant cannot be read (grantOrRefuse): what it is, and so what acting on it does,
 * is not known. A connection is otherwise acted on whichever harness account recorded it: `use` and `remove` are the
 * person's own commands, and one person uses this computer account, under any of their harness logins.
 */
function mustRead(root, key) {
  grantOrRefuse(root, key);
}

/** Without a session: the default for new sessions. With one: that session only. Any harness account's (mustRead). */
export function useConnection(root, ref, { sessionId = null } = {}) {
  const key = mustFind(root, ref);
  mustRead(root, key);
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
  mustRead(root, key);
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
 * The most recently used connection made under harness account `account` (a value, or a function read only when
 * there is a choice to make). Without one, when the default is another account's: the most recently used connection
 * of the default's node made before accounts were recorded, rather than the other account's. Else null.
 */
function accountConnection(root, account) {
  const known = knownKeys(root);
  if (known.length < 2) return null;
  const by = new Map(known.map((k) => [k, accountId(readGrant(connectionPaths(root, k))?.harnessAccount)]));
  if (![...by.values()].some(Boolean)) return null;
  const a = accountId(typeof account === 'function' ? account() : account);
  if (!a) return null;
  const order = recent(root);
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  const newest = (keys) => keys.sort((x, y) => rank(x) - rank(y) || x.localeCompare(y))[0] ?? null;
  const own = newest(known.filter((k) => by.get(k) === a));
  if (own) return own;
  const def = defaultConnection(root);
  if (!def || !by.get(def)) return null;
  const origin = originOf(readGrant(connectionPaths(root, def)).nodeUrl);
  return newest(known.filter((k) => by.get(k) === null && heldFor(root, k, origin)));
}

/**
 * The connection a session uses (see the order at the top), without fixing it: its pin, else where a new session
 * goes. The MCP server reads this; it never writes a pin, since it knows no transcript. `account` is the harness
 * account the session runs under (a value, or a function read only when it decides something).
 */
export function sessionConnection(root, { sessionId = null, env = process.env, account = null } = {}) {
  migrateLegacy(root);
  const pinned = pinnedConnection(root, sessionId);
  if (pinned !== undefined) return pinned;
  const wanted = env[NODE_ENV];
  if (wanted) return findConnection(root, wanted);
  return accountConnection(root, account) ?? defaultConnection(root);
}

/**
 * The connection this session uses, fixed for the session on a hook's first call. A hook passes the session's
 * transcript, which the pin keeps: a move counts its lines, and the pin lives as long as it does.
 */
export function resolveSession(root, { sessionId = null, env = process.env, transcriptPath = null, account = null } = {}) {
  const transcript = existingTranscript(transcriptPath);
  const key = sessionConnection(root, { sessionId, env, account });
  const was = sessionId ? readJson(pinPath(root, sessionId)) : null;
  if (was && 'connection' in was) {
    recordTranscript(root, sessionId, transcriptPath);
    return key;
  }
  // a connection whose grant cannot be read now is not pinned: the next hook resolves the session again
  if (key && !readGrant(connectionPaths(root, key))) return null;
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
