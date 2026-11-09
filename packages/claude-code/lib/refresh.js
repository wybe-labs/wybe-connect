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
//   refused  a refusal for good marks the connection (home.js markRefused) only from inside the lock
//            and only while the file still holds the refresh token that was refused: a race between
//            processes never marks a live grant.
// A caller that cannot take the lock in REFRESH_LOCK_MAX_WAIT_MS gets null (a failure that may pass)
// and never refreshes on its own.

import { join, dirname } from 'node:path';
import { readJson, saveCredentials, isRefused, markRefused } from './home.js';
import { refreshTokens } from './oauth.js';
import { acquireAsync } from './lock.js';

export const REFRESH_LOCK_MAX_HOLD_MS = 30 * 1000;
export const REFRESH_LOCK_MAX_WAIT_MS = 45 * 1000;
const REFRESH_LOCK_UNREADABLE_MS = 5 * 1000;

/** The refresh lock of the connection whose files are `p` (lib/connections.js connectionPaths, or the single layout). */
export const refreshLockPath = (p) => join(dirname(p.credentials), 'refresh.lock');

const sameGrant = (a, b) => (a?.grantId ?? null) === (b?.grantId ?? null);

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
 * Runs `fn()` holding the refresh lock of connection `p` and returns its value; null when the lock
 * cannot be taken (held by a live process for too long, or the connection's directory is gone).
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
    return await fn();
  } finally {
    held.release();
  }
}

/**
 * New credentials for connection `p` after its node refused the access token in `c` (the grant the
 * caller loaded): the tokens another process stored meanwhile, or one refresh, stored before the
 * lock is released. Returns the whole credentials to use, or null when there are none: the grant was
 * removed, replaced (another grantId) or refused, the refresh failed, or the lock stayed busy.
 */
export async function refreshStored(p, c, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs, lock = {} } = {}) {
  if (!p?.credentials || !c) return null;
  const onEntry = quietJson(p.credentials);
  if (!onEntry || isRefused(onEntry) || !sameGrant(onEntry, c)) return null; // no lock file in a removed connection's directory
  return withRefreshLock(p, async () => {
    const onDisk = quietJson(p.credentials);
    if (!onDisk || isRefused(onDisk) || !sameGrant(onDisk, c)) return null;
    // another process refreshed after this caller loaded its tokens
    if (onDisk.accessToken !== c.accessToken && !expired(onDisk, now())) return onDisk;
    if (!onDisk.refreshToken) return null;
    const next = await refreshTokens({
      tokenEndpoint: onDisk.tokenEndpoint, clientId: onDisk.clientId, refreshToken: onDisk.refreshToken,
      resource: onDisk.resource ?? onDisk.mcpEndpoint, requestedScopes: onDisk.scopes, fetchImpl, now: now(), timeoutMs,
      onRefused: () => markRefused(p, onDisk, { now }),
    });
    if (!next) return null;
    const fresh = { ...onDisk, ...next };
    const after = quietJson(p.credentials);
    // Stored only over the grant and refresh token presented: a grant removed or replaced while the
    // call ran (a new sign-in, `connect remove`) is never written over. The caller may still use
    // the new tokens for the call it is making.
    if (after && sameGrant(after, onDisk) && after.refreshToken === onDisk.refreshToken) saveCredentials(fresh, p);
    return fresh;
  }, lock);
}
