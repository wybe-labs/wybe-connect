// The one way a connection's grant is refreshed. Every process of a connection (each session's
// poller, the MCP proxy, flushes, distil deliveries, `connect`) holds the same tokens, and a
// refresh token is single-use (OAuth 2.1 rotation): presenting a used one again may end the grant. So two processes that meet an expired access token at the same
// moment must never both refresh:
//   lock     refresh.lock in the connection's directory (lib/lock.js acquireAsync: an O_EXCL file
//            with pid, token and time), one refresh at a time across every process on the machine.
//            A dead holder's lock is taken over at once, a live holder's after
//            REFRESH_LOCK_MAX_HOLD_MS (a refresh is one token call with a 10 s timeout).
//   re-read  inside the lock, credentials.json is read again. Tokens another process stored after
//            the caller loaded its own (another access token, not expired) are the answer, with no
//            token call. Otherwise the refresh token on disk, never the caller's copy, is presented.
//   store    the new tokens are written (temp file + rename) before the lock is released, and only
//            while the file still holds the grant and refresh token that was presented (a grant
//            replaced meanwhile is never written over; the caller still gets the tokens for its call).
//   keep     the server has rotated the grant once it answers, so the old refresh token is spent.
//            The new tokens are first kept beside credentials.json (credentials.rotated.json, temp
//            file + rename, in place when that cannot be done, with a hash of the refresh token on
//            disk they replace), then saved; both writes are retried for a few seconds without
//            blocking, and the kept file is removed once the save holds. So a process that dies or
//            gives up while saving loses nothing: the next refresh, inside the lock, adopts the kept
//            tokens instead of presenting the spent token, which would be refused for good and mark a
//            live grant. Kept tokens whose access token has expired are refreshed at once with their
//            own refresh token. A kept file that is there but busy (EBUSY, EPERM, EACCES) is never
//            taken for «none»: that call presents nothing. One that cannot be parsed holds nothing
//            usable and is set aside (credentials.rotated.json.unreadable-<time>). A holder whose lock
//            was taken over (stillHeld false) keeps but does not write credentials.json; the new
//            holder adopts. A new sign-in or a renewal removes the kept file (connections.js).
//   refused  a refusal for good marks the connection (home.js markRefused) only from inside the lock
//            and only while the file still holds the refresh token that was refused: a race between
//            processes never marks a live grant. A takeover race can still mark it (the new holder
//            presents the token the old one has just had replaced), so the mark is undone from the
//            kept tokens, whichever side writes last: the old holder keeps, then reads the file and
//            heals a refusal of the token it replaced; the new holder marks, then reads the kept file
//            and adopts tokens that replaced the token it presented. A refused connection with such a
//            kept file is adopted the same way.
// A caller that cannot take the lock in REFRESH_LOCK_MAX_WAIT_MS gets null (a failure that may pass)
// and never refreshes on its own.

import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { readJson, saveCredentials, isRefused, markRefused, writeJsonPrivate } from './home.js';
import { refreshTokens } from './oauth.js';
import { acquireAsync } from './lock.js';

export const REFRESH_LOCK_MAX_HOLD_MS = 30 * 1000;
export const REFRESH_LOCK_MAX_WAIT_MS = 45 * 1000;
const REFRESH_LOCK_UNREADABLE_MS = 5 * 1000;

/** The refresh lock of the connection whose files are `p` (lib/connections.js connectionPaths, or the single layout). */
export const refreshLockPath = (p) => join(dirname(p.credentials), 'refresh.lock');

/** Rotated tokens a refresh could not save, kept for the next refresh of the same grant (see «keep»). */
export const rotatedPath = (p) => join(dirname(p.credentials), 'credentials.rotated.json');

/** Waits between the tries of a write that fails (a save, a keep), inside the lock: about 3.8 s in all, never blocking. */
const WRITE_RETRY_WAITS_MS = [10, 20, 40, 80, 160, 320, 640, 1000, 1500];

/** Read errors of a file that is there but busy for a moment (Windows, a scanner, a rename in flight). */
const BUSY_READ = new Set(['EBUSY', 'EPERM', 'EACCES']);

const UNREADABLE = Symbol('unreadable');

const sameGrant = (a, b) => (a?.grantId ?? null) === (b?.grantId ?? null);
const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The default save: one rename try per call, so retried() does the waiting without blocking the event loop. */
const saveOnce = (c, p) => saveCredentials(c, p, { tries: 1 });

/** Runs write() until it does not throw, waiting between tries without blocking. True when it held. */
async function retried(write) {
  for (let i = 0; ; i++) {
    try {
      write();
      return true;
    } catch {
      if (i >= WRITE_RETRY_WAITS_MS.length) return false;
      await sleep(WRITE_RETRY_WAITS_MS[i]);
    }
  }
}

function forget(path) {
  try {
    unlinkSync(path);
  } catch {
    // not there
  }
}

/** JSON at `path` read with `read`: { value }, { missing } (ENOENT), { busy } (there, but busy now), or { corrupt }. */
function readState(path, read) {
  let text;
  try {
    text = read(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true };
    return BUSY_READ.has(err?.code) ? { busy: true } : { corrupt: true };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { corrupt: true };
  }
}

/** Whether stored tokens say their access token has expired; a grant without expiresAt is taken as not expired. */
function expired(c, at) {
  const until = Date.parse(c?.expiresAt);
  return Number.isFinite(until) && until <= at;
}

function quietJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

/**
 * The tokens kept for grant `onDisk` that replaced the refresh token now on disk; null when there are
 * none for it (no file, another grant, another refresh token, or a file that cannot be parsed, which
 * is set aside); UNREADABLE when the file is there but busy, so it may hold the only live tokens.
 */
function keptFor(p, onDisk, read = readFileSync) {
  const path = rotatedPath(p);
  const s = readState(path, read);
  if (s.busy) return UNREADABLE;
  if (s.corrupt) {
    try {
      renameSync(path, `${path}.unreadable-${Date.now()}`);
    } catch {
      // still in the way: tried again on the next refresh
    }
    return null;
  }
  const kept = s.value;
  if (!kept || !onDisk?.refreshToken || !sameGrant(kept, onDisk) || kept.from !== tokenHash(onDisk.refreshToken)) return null;
  const t = kept.tokens;
  return t && typeof t.accessToken === 'string' && typeof t.refreshToken === 'string' ? t : null;
}

/** `held` without the refused mark: kept tokens that replaced its refresh token prove the grant lives. */
function unrefused(held) {
  const { refusedAt: _refused, ...live } = held;
  return live;
}

/**
 * The stored grant `held` of connection `p` with the tokens a refresh kept for it (see «keep»), for a
 * caller that presents its refresh token itself under the refresh lock (connect-cli renewStored):
 * `held` itself when there are none, null when a kept file is there but cannot be read now.
 */
export function liveGrant(p, held, { read = readFileSync } = {}) {
  if (!held) return held;
  const kept = keptFor(p, held, read);
  if (kept === UNREADABLE) return null;
  return kept ? { ...unrefused(held), ...kept } : held;
}

/**
 * Keeps `tokens` as the ones that replace the refresh token of `onDisk` (see «keep»): temp file + rename,
 * retried, else written in place. When nothing can be written, an older kept file is removed rather
 * than left holding tokens this refresh has just spent. False when they could not be kept.
 */
async function keepSurely(p, onDisk, tokens) {
  const path = rotatedPath(p);
  const body = { grantId: onDisk.grantId ?? null, from: tokenHash(onDisk.refreshToken), tokens };
  if (await retried(() => writeJsonPrivate(path, body, { tries: 1 }))) return true;
  try {
    writeFileSync(path, JSON.stringify(body, null, 2), { mode: 0o600 }); // inside the lock: no reader sees it half done
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort, as writeJsonPrivate
    }
    return true;
  } catch {
    forget(path);
    return false;
  }
}

/**
 * Runs `fn({ stillHeld })` holding the refresh lock of connection `p` and returns its value; null when
 * the lock cannot be taken (held by a live process for too long, or the connection's directory is gone).
 */
export async function withRefreshLock(p, fn, { maxWaitMs = REFRESH_LOCK_MAX_WAIT_MS, maxHoldMs = REFRESH_LOCK_MAX_HOLD_MS } = {}) {
  if (!p?.credentials) return null;
  let held;
  try {
    held = await acquireAsync(refreshLockPath(p), { maxWaitMs, maxHoldMs, unreadableMs: REFRESH_LOCK_UNREADABLE_MS });
  } catch {
    return null;
  }
  try {
    return await fn({ stillHeld: held.stillHeld });
  } finally {
    held.release();
  }
}

/**
 * New credentials for connection `p` after its node refused the access token in `c` (the grant the
 * caller loaded): the tokens another process stored meanwhile, tokens a refresh kept, or one refresh,
 * stored before the lock is released. Returns the whole credentials to use, or null when there are
 * none: the grant was removed, replaced (another grantId) or refused, the refresh failed, a kept file
 * was busy, or the lock stayed busy.
 */
export async function refreshStored(p, c, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs, lock = {}, save = saveOnce, read = readFileSync } = {}) {
  if (!p?.credentials || !c) return null;
  const onEntry = quietJson(p.credentials);
  if (!onEntry || !sameGrant(onEntry, c)) return null; // no lock file in a removed connection's directory
  if (isRefused(onEntry) && !existsSync(rotatedPath(p))) return null;
  return withRefreshLock(p, async ({ stillHeld }) => {
    const onDisk = quietJson(p.credentials);
    if (!onDisk || !sameGrant(onDisk, c)) return null;
    const refused = isRefused(onDisk);
    // another process refreshed after this caller loaded its tokens
    if (!refused && onDisk.accessToken !== c.accessToken && !expired(onDisk, now())) return onDisk;
    if (!onDisk.refreshToken) return null;
    // a refresh the server accepted whose save did not hold: its tokens, never the spent refresh token
    const kept = keptFor(p, onDisk, read);
    if (kept === UNREADABLE) return null; // it may hold the only live tokens: present nothing this call
    if (refused && !kept) return null;
    const live = unrefused(onDisk); // differs only when refused, and then the kept tokens prove the grant lives
    const adopt = async (tokens) => {
      const adopted = { ...live, ...tokens };
      if (stillHeld() && (await retried(() => save(adopted, p)))) forget(rotatedPath(p));
      return adopted;
    };
    const base = kept ? { ...live, ...kept } : live;
    if (kept && !expired(base, now())) return adopt(kept);
    let refusedNow = false;
    const next = await refreshTokens({
      tokenEndpoint: onDisk.tokenEndpoint, clientId: onDisk.clientId, refreshToken: base.refreshToken,
      resource: onDisk.resource ?? onDisk.mcpEndpoint, requestedScopes: onDisk.scopes, fetchImpl, now: now(), timeoutMs,
      onRefused: () => {
        refusedNow = true;
        markRefused(p, onDisk, { now });
      },
    });
    if (!next) {
      if (!refusedNow) return null;
      // marked, then the kept file read: a holder whose lock was taken over may have had this token
      // replaced while the call ran (see «refused»)
      const late = keptFor(p, onDisk, read);
      if (late && late !== UNREADABLE && late.refreshToken !== base.refreshToken) return adopt(late);
      // the kept refresh token itself was refused: the grant is dead. Nothing kept is left, so a
      // refused connection makes no further token call (the entry check above).
      if (kept && late?.refreshToken === base.refreshToken) forget(rotatedPath(p));
      return null;
    }
    const tokens = kept ? { ...kept, ...next } : next;
    const fresh = { ...live, ...tokens };
    // Kept and stored only over the grant and refresh token read from disk above: a grant removed or
    // replaced while the call ran (a new sign-in, `connect remove`) is never written over. The caller
    // may still use the new tokens for the call it is making.
    const holdsSpent = (x) => sameGrant(x, onDisk) && x.refreshToken === onDisk.refreshToken;
    const before = readState(p.credentials, read);
    if (before.missing || (before.value && !holdsSpent(before.value))) return fresh;
    await keepSurely(p, onDisk, tokens);
    // kept, then the file read: a refusal of the token these tokens replaced is healed (see «refused»)
    const after = readState(p.credentials, read).value;
    if (!after || !holdsSpent(after)) return fresh; // unreadable now: kept, the next refresh adopts
    if (stillHeld() || isRefused(after)) {
      if (await retried(() => save(fresh, p))) forget(rotatedPath(p));
    }
    return fresh;
  }, lock);
}
