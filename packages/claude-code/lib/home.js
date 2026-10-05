// Where wybe-connect keeps its state on this machine: ~/.wybe-connect (override with
// WYBE_CONNECT_HOME, which tests use to get a private directory each). Claude Code uses the root;
// Codex and Cursor use ~/.wybe-connect/codex and ~/.wybe-connect/cursor (see harnessHome), each
// with the same layout:
//   credentials.json          the OAuth grant for the node, mode 600 (chmod is best effort on
//                             Windows, where the profile directory's ACL is the protection)
//   state/<transcript-id>.json  the flush cursor per transcript (Cursor: per conversation)
//   state/open-questions.json   the node's open questions from the last tool response
//   state/surfaced-questions.json  (Cursor) question ids already put to the person, and when
//   queue/                    payloads the node has not taken yet (see queue.js for the bounds)
//   spool/                    (Cursor) redacted hook records of a conversation not yet flushed

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';

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
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes atomically (temp + rename) with owner-only permissions. */
export function writeJsonPrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows without POSIX modes: the profile directory ACL is the protection
  }
  renameSync(tmp, path);
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
