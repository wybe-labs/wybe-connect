// Which connection may take a file that no session pin assigns: a transcript older than the
// connections (or never hooked), or a project's memory file. The first connection whose import or
// run takes one claims it, and every other connection of the harness home skips it, so one node's
// work never reaches another node only because both imported. A pinned transcript follows its pin
// (lib/connections.js sessionLines) and is never claimed. A claim stays with a removed connection:
// its files go nowhere, as a removed connection's pinned lines do.
//
// File: <harness home>/state/claims.json { version: 1, claims: { [transcriptKey]: <connection> } },
// written under state/claims.lock (lib/lock.js). A claim goes when its file is gone.

import { existsSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { withLock } from './lock.js';
import { readJson, writeJsonPrivate } from './home.js';

const fileOf = (root) => join(root, 'state', 'claims.json');
const lockOf = (root) => join(root, 'state', 'claims.lock');

/** A file's identity: its full path, compared the way the file system does (lib/distil.js transcriptKey). */
export const claimKey = (path) => (process.platform === 'win32' ? win32.resolve(path).toLowerCase() : posix.resolve(path));

function read(root) {
  try {
    const c = readJson(fileOf(root))?.claims;
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {}; // being replaced, or unreadable: a fresh claim set; the next write puts it right
  }
}

/** The connection holding a file, or null. */
export function claimOf(root, path) {
  return read(root)[claimKey(path)] ?? null;
}

/** Every claim, as { [claimKey]: connection }, for checking many files at once. */
export function claims(root) {
  return read(root);
}

/**
 * Claims each file no other connection holds for `connection`. Returns the set of claim keys
 * `connection` holds among them afterwards. Throws ELOCKBUSY when the claims stay locked.
 */
export function claim(root, connection, paths) {
  if (!paths.length) return new Set();
  return withLock(lockOf(root), ({ stillHeld }) => {
    const all = read(root);
    let changed = false;
    for (const [k, v] of Object.entries(all)) {
      if (typeof v !== 'string' || !existsSync(k)) {
        delete all[k];
        changed = true;
      }
    }
    const mine = new Set();
    for (const path of paths) {
      const k = claimKey(path);
      if (all[k] === undefined) {
        all[k] = connection;
        changed = true;
      }
      if (all[k] === connection) mine.add(k);
    }
    if (changed) {
      if (!stillHeld()) throw Object.assign(new Error('lost the claims lock; not writing'), { code: 'ELOCKLOST' });
      writeJsonPrivate(fileOf(root), { version: 1, claims: all });
    }
    return mine;
  }, { tries: 40, waitMs: 50 });
}
