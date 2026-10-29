// What the node is told about an open Claude Code or Codex session (sessions_report): which
// harness, the session id, the project, a short title, the vendor account and when it was active.
//   project  the last segment of the session's cwd, never the path
//   title    the first prompt the person typed (Claude Code transcript / Codex rollout), one line,
//            redacted, at most 80 characters
//   account  display only. Claude Code: oauthAccount.emailAddress in <CLAUDE_CONFIG_DIR or home>/.claude.json.
//            Codex: the `email` claim of the id_token payload in <CODEX_HOME or ~/.codex>/auth.json,
//            decoded here and nothing else; no token ever leaves this module.
// Read-only on every file it looks at; a missing or unreadable file means the field is left out.

import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, stripInjected } from './transcript.js';
import { parseRollout } from './codex-rollout.js';
import { redact } from './redact.js';

export const TITLE_MAX = 80;
export const ACCOUNT_MAX = 200;
const TITLE_READ_BYTES = 1024 * 1024;
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

/** One sessions_report entry. `title` may be given (a cached one); otherwise it is read from the transcript. */
export function sessionInfo({ harness, sessionId, cwd = null, transcriptPath = null, env = process.env, home = homedir(), startedAt, lastActiveAt, state, title = undefined }) {
  const out = { id: sessionId, harness };
  const t = title === undefined ? titleFromTranscript(transcriptPath, harness) : title;
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
