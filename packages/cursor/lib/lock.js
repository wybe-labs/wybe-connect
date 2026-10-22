// A cross-process lock file for the distil state (lib/distil.js). Synchronous, because the hooks
// and the watchdog hold it only around a read-modify-write of one JSON file.
//
//   take     open(<lock>, 'wx') and write { pid, token, at }. Exclusive by the file system.
//   wait     a lock whose pid is alive is busy, however long it has been held: a laptop that sleeps
//            mid-hook, an AV scan or a slow disk is still a live holder (QA R4-7). No age rule.
//   take over  only a dead holder's lock (process.kill(pid, 0) says ESRCH); a lock with no readable
//            pid only after LOCK_UNREADABLE_MS (its writer died between create and write); and,
//            for a pid the OS has since reused, after LOCK_MAX_HOLD_MS.
//   fence    the holder gets stillHeld(): true while the lock file still carries its token. A
//            holder checks it right before it writes, so a holder whose lock was taken over never
//            overwrites the new holder's work, and on release it deletes only its own lock.
// A takeover renames the lock aside first and checks that what it moved is the very file it
// judged (same inode), so two contenders reaping the same dead lock, or a reaper racing a fresh
// holder, cannot delete a live one; a live lock moved by mistake is linked back.

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, renameSync, linkSync, statSync, fstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const LOCK_UNREADABLE_MS = 60 * 1000;
export const LOCK_MAX_HOLD_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** What a lock file says, read through ONE handle: its identity (inode), age and content always belong to the same file. */
function readHolder(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'EPERM' || err?.code === 'EBUSY') return null;
    throw err;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      // empty or half-written: no pid to judge by
    }
    return { holder, mtimeMs: Number(st.mtimeMs), ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

const inoOf = (file) => {
  try {
    return statSync(file, { bigint: true }).ino;
  } catch {
    return null;
  }
};

function reapable(seen, now, alive) {
  const { holder, mtimeMs } = seen;
  if (!holder || !Number.isInteger(holder.pid)) return now - mtimeMs > LOCK_UNREADABLE_MS;
  if (!alive(holder.pid)) return true;
  const at = Date.parse(holder.at);
  return Number.isFinite(at) && now - at > LOCK_MAX_HOLD_MS;
}

/** Moves a dead lock aside. If what was moved turns out to be someone's live lock, it goes back. */
function reap(file, seen) {
  const aside = `${file}.reap-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(file, aside);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'EPERM' || err?.code === 'EBUSY') return;
    throw err;
  }
  // Same file only by identity: a new holder's lock that is still empty has the same (null) token
  // as an old empty one, but never the same inode (#4's second R4-7 race).
  const same = seen.ino !== undefined && inoOf(aside) === seen.ino;
  if (!same) {
    try {
      linkSync(aside, file); // put the live lock back, unless a third process already took the name
    } catch {
      // that holder's fence (stillHeld) now reads false: it will not write
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // best effort
  }
}

function tryTake(file, token) {
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (err) {
    // Windows: a lock being deleted reads as EPERM for a moment; that is busy, not an error.
    if (err?.code === 'EEXIST' || err?.code === 'EPERM' || err?.code === 'EBUSY') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Takes the lock and returns { stillHeld, release } (for a holder that awaits, such as the
 * watchdog's delivery). Throws an Error with code 'ELOCKBUSY' when the lock stayed with a live
 * holder for `tries` attempts.
 */
export function acquire(file, { tries = 50, waitMs = 100, alive = isAlive, now = Date.now } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(12).toString('hex');
  let taken = false;
  for (let i = 0; i < tries && !taken; i++) {
    taken = tryTake(file, token);
    if (taken) break;
    const seen = readHolder(file);
    if (seen && reapable(seen, now(), alive)) {
      reap(file, seen);
      taken = tryTake(file, token);
      if (taken) break;
    }
    if (i < tries - 1) sleep(waitMs);
  }
  if (!taken) {
    const err = new Error('the distil lock is held by a live process');
    err.code = 'ELOCKBUSY';
    throw err;
  }
  const stillHeld = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).token === token;
    } catch {
      return false;
    }
  };
  const release = () => {
    if (!stillHeld()) return;
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
  return { stillHeld, release };
}

export const _internals = { readHolder, reapable, reap };

/** Runs fn({ stillHeld }) under the lock and returns its value; see acquire for the options. */
export function withLock(file, fn, opts = {}) {
  const { stillHeld, release } = acquire(file, opts);
  try {
    return fn({ stillHeld });
  } finally {
    release();
  }
}
