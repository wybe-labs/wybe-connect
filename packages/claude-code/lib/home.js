// Where wybe-connect keeps its state on this machine: ~/.wybe-connect (override with
// WYBE_CONNECT_HOME, which tests use to get a private directory each). Claude Code uses the root;
// Codex and Cursor use ~/.wybe-connect/codex and ~/.wybe-connect/cursor (see harnessHome), each
// with the same layout:
//   connections/<name>/       one per node or account (lib/connections.js), each holding:
//     credentials.json        the OAuth grant for the node, mode 600 (chmod is best effort on
//                             Windows, where the profile directory's ACL is the protection)
//     queue/                  payloads the node has not taken yet (see queue.js for the bounds)
//     open-questions.json     the node's open questions from the last tool response
//     surfaced-questions.json (Cursor) question ids already put to the person, and when
//   connections.json          which connection is the default (lib/connections.js)
//   state/<transcript-id>.json  the flush cursor per transcript (Cursor: per conversation)
//   state/sessions/<id>.json  the connection a session uses
//   spool/                    (Cursor) redacted hook records of a conversation not yet flushed
// paths() below is the single-connection layout of 0.1 (credentials.json, queue/ and the caches in
// the root), which connections.js migrates from and builds on.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs';

export function homePath() {
  return process.env.WYBE_CONNECT_HOME || join(homedir(), '.wybe-connect');
}

export const HARNESSES = Object.freeze(['claude-code', 'codex', 'cursor']);

/**
 * Each harness is its own pairing (its own OAuth client, consent and grant: B1.1's
 * `assistant`), so each keeps its own credentials, queue and open-question cache. A Codex hook
 * must never drain Claude Code's queue with the Codex token. Claude Code keeps the root (the C2
 * layout); the others live in a subdirectory named after the harness.
 */
export function harnessHome(harness, root = homePath()) {
  if (!HARNESSES.includes(harness)) throw new Error(`unknown harness ${harness}`);
  return harness === 'claude-code' ? root : join(root, harness);
}

export function paths(root = homePath()) {
  return {
    root,
    credentials: join(root, 'credentials.json'),
    state: join(root, 'state'),
    queue: join(root, 'queue'),
    spool: join(root, 'spool'),
    openQuestions: join(root, 'state', 'open-questions.json'),
    surfacedQuestions: join(root, 'state', 'surfaced-questions.json'),
    cursor: (transcriptId) => join(root, 'state', `${transcriptId}.json`),
  };
}

export function readJson(path) {
  if (!path) return null; // a session without a connection has no credentials or caches (connections.js)
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_TRIES = 12;

/**
 * Writes atomically (temp + rename) with owner-only permissions. On Windows a rename over a file
 * another hook is reading or replacing at that moment fails with EPERM, EACCES or EBUSY for a few
 * milliseconds: it is retried with a short wait, and given up (temp file removed) only when it
 * stays busy.
 */
export function writeJsonPrivate(path, value, { renameImpl = renameSync } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows without POSIX modes: the profile directory ACL is the protection
  }
  for (let i = 1; ; i++) {
    try {
      renameImpl(tmp, path);
      return;
    } catch (err) {
      if (!BUSY.has(err?.code) || i >= RENAME_TRIES) {
        try {
          unlinkSync(tmp);
        } catch {
          // already gone
        }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * i);
    }
  }
}

export function loadCredentials(p = paths()) {
  const c = readJson(p.credentials);
  if (c === null) return null;
  if (c.version !== 1 || typeof c.accessToken !== 'string' || typeof c.mcpEndpoint !== 'string' || !Array.isArray(c.scopes)) {
    throw new Error('credentials.json has an unexpected shape; run connect again');
  }
  return c;
}

export function saveCredentials(credentials, p = paths()) {
  writeJsonPrivate(p.credentials, { version: 1, ...credentials });
}
