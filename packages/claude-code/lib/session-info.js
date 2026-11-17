// What the node is told about an open Claude Code or Codex session (sessions_report): which
// harness, the session id, the project, a short title, the vendor account and when it was active.
//   project  the last segment of the session's cwd, never the path
//   title    the session's own name when it has one: the name Claude shows for it (its live mark's `name` in
//            <claude home>/sessions/<pid>.json, else the last `custom-title` line of its transcript). Else the first
//            prompt the person typed (Claude Code transcript / Codex rollout). One line, redacted, at most 80 characters.
//   last_active_at  the time of the last line the transcript holds (its own `timestamp`), not the file's modified
//            time: copying or touching transcripts in bulk gives hundreds of them one and the same file time.
//   account  display only, and only from the session's own process: a scan of other sessions never stamps them with
//            the account it runs under (two logins on one machine share the transcripts).
//            Claude Code: oauthAccount.emailAddress in <CLAUDE_CONFIG_DIR or home>/.claude.json.
//            Codex: the `email` claim of the id_token payload in <CODEX_HOME or ~/.codex>/auth.json,
//            decoded here and nothing else; no token ever leaves this module.
// Read-only on every file it looks at; a missing or unreadable file means the field is left out.

import { readFileSync, readdirSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, stripInjected } from './transcript.js';
import { parseRollout } from './codex-rollout.js';
import { redact } from './redact.js';

export const TITLE_MAX = 80;
export const ACCOUNT_MAX = 200;
const TITLE_READ_BYTES = 1024 * 1024;
export const TAIL_BYTES = 256 * 1024;
const NL = String.fromCharCode(10);
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${SEPARATORS}]+`, 'g');

/** The last segment of a POSIX or Windows path; null when there is none. */
export function projectOf(cwd) {
  if (typeof cwd !== 'string') return null;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1);
  if (!last || /^[A-Za-z]:$/.test(last)) return null;
  return last.replace(CONTROL, ' ').trim().slice(0, 200) || null;
}

/** One line, harness wrapping removed, redacted, at most TITLE_MAX characters; null when nothing is left. */
export function cleanTitle(text) {
  if (typeof text !== 'string') return null;
  const one = stripInjected(text).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!one) return null;
  const safe = redact(one).text;
  return safe.length > TITLE_MAX ? `${safe.slice(0, TITLE_MAX - 1).trimEnd()}…` : safe;
}

function readHead(path, max) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The end of a file, from its last TAIL_BYTES (the first, likely cut, line dropped); null when it cannot be read. */
function readTail(path, max = TAIL_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - max);
    const buf = Buffer.alloc(Math.min(max, size));
    const n = readSync(fd, buf, 0, buf.length, from);
    const text = buf.subarray(0, n).toString('utf8');
    return from > 0 ? text.slice(text.indexOf(NL) + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/**
 * What the end of a Claude Code transcript says: { name, lastAt }. `name` is the last `custom-title` line's name
 * (cleaned as a title), `lastAt` the newest `timestamp` of its lines (ISO), each null when the tail has none.
 * `text` may be given (the tail already read); otherwise it is read from `path`.
 */
export function transcriptTailFacts(path, { text = undefined } = {}) {
  let tail = text;
  if (tail === undefined) {
    try {
      tail = readTail(path);
    } catch {
      return { name: null, lastAt: null };
    }
  }
  let name = null;
  let last = -Infinity;
  const lines = String(tail ?? '').split(NL);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (name === null && o?.type === 'custom-title' && typeof o.customTitle === 'string') name = cleanTitle(o.customTitle);
    const at = typeof o?.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(at) && at > last) last = at;
    if (name !== null && Number.isFinite(last) && i < lines.length - 64) break;
  }
  return { name, lastAt: Number.isFinite(last) ? new Date(last).toISOString() : null };
}

/**
 * The names Claude gives its sessions now, from its own marks (<claude home>/sessions/<pid>.json, `name`): a Map of
 * session id -> name (cleaned as a title). The newest mark of a session wins (`nameSince`, else `updatedAt`).
 */
export function claudeSessionNames(claudeHome) {
  const out = new Map();
  const since = new Map();
  let names = [];
  try {
    names = readdirSync(join(claudeHome, 'sessions'));
  } catch {
    return out;
  }
  for (const f of names) {
    if (!/^\d+\.json$/.test(f)) continue;
    const o = readJsonQuiet(join(claudeHome, 'sessions', f));
    if (typeof o?.sessionId !== 'string' || typeof o?.name !== 'string') continue;
    const name = cleanTitle(o.name);
    if (!name) continue;
    const at = Number(o.nameSince ?? o.updatedAt ?? 0) || 0;
    if (out.has(o.sessionId) && since.get(o.sessionId) > at) continue;
    out.set(o.sessionId, name);
    since.set(o.sessionId, at);
  }
  return out;
}

/** The person's first prompt in a transcript, cleaned (cleanTitle). Each line is read on its own, so a broken one is skipped. */
export function titleFromTranscript(path, harness) {
  if (typeof path !== 'string' || !path) return null;
  let text;
  try {
    text = readHead(path, TITLE_READ_BYTES);
  } catch {
    return null;
  }
  const parse = harness === 'codex' ? parseRollout : parseTranscript;
  let sidechain = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entries;
    try {
      entries = parse(`${line}\n`).entries;
    } catch {
      continue;
    }
    for (const e of entries) {
      // a Codex rollout's first line says whether it is a subagent's thread, for the whole file;
      // a Claude Code transcript marks each subagent line on its own
      if (e.sidechain && harness === 'codex') sidechain = true;
      if (e.kind === 'prompt' && !e.meta && !e.sidechain && !sidechain) {
        const t = cleanTitle(e.text);
        if (t) return t;
      }
    }
  }
  return null;
}

function accountLabel(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, ' ').trim();
  return s && s.length <= ACCOUNT_MAX ? s : null;
}

function readJsonQuiet(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function claudeAccount(env = process.env, home = homedir()) {
  const dir = env.CLAUDE_CONFIG_DIR || home;
  return accountLabel(readJsonQuiet(join(dir, '.claude.json'))?.oauthAccount?.emailAddress);
}

export function codexAccount(env = process.env, home = homedir()) {
  const dir = env.CODEX_HOME || join(home, '.codex');
  const idToken = readJsonQuiet(join(dir, 'auth.json'))?.tokens?.id_token;
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return accountLabel(payload?.email);
  } catch {
    return null;
  }
}

/** The account the harness itself is signed in to; null for Cursor, which keeps none we can read. */
export function accountOf(harness, env = process.env, home = homedir()) {
  if (harness === 'codex') return codexAccount(env, home);
  return harness === 'claude-code' ? claudeAccount(env, home) : null;
}

/**
 * One sessions_report entry, sent from the session's own process (so the account is its own). `name` is the session's
 * own name when known (claudeSessionNames, transcriptTailFacts) and wins over `title`; `title` may be given (a cached
 * first prompt), otherwise it is read from the transcript.
 */
export function sessionInfo({ harness, sessionId, cwd = null, transcriptPath = null, env = process.env, home = homedir(), startedAt, lastActiveAt, state, title = undefined, name = null }) {
  const out = { id: sessionId, harness };
  const t = name || (title === undefined ? titleFromTranscript(transcriptPath, harness) : title);
  if (t) out.title = t;
  const project = projectOf(cwd);
  if (project) out.project = project;
  const account = accountOf(harness, env, home);
  if (account) out.account = account;
  out.started_at = startedAt;
  out.last_active_at = lastActiveAt;
  out.state = state;
  return out;
}
