// How a task from the colleague reaches a LIVE session (lib/bridge.js does the node side).
//
// Claude Code: hooks/task-wait.js is an `asyncRewake` command hook on SessionStart, Stop and
// StopFailure. It runs in the background as the session's poller; when a task arrives it exits 2
// with the notice on stderr, which wakes Claude even when the session is idle (the notice is shown
// as a system reminder). Each Stop re-arms it, and a newer poller supersedes the older, which exits
// 0 quietly. UserPromptSubmit pauses it while the person's own turn runs, so a task always gets a
// turn of its own and the next Stop's last message is its result. SessionEnd (1.5 s) only marks
// the session closed and starts a detached sender for the closing sessions_report.
//
// Codex: no hook can wake an idle Codex session, so hooks/bridge.js starts a detached poller
// (bin/bridge.js poll) at SessionStart, and any Stop starts one again when it is gone. On a task it
// runs `codex queue --thread <session> --message <notice>` (an argument list, never a shell). When
// that fails, the notice stays in the session's state and the next Stop hook returns
// {"decision":"block","reason":<notice>}, once, which gives the task a new turn. A queued task's
// result is the Stop of the turn whose prompt carries the task's mark.

import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { harnessHome } from './home.js';
import { sessionPaths } from './connections.js';
import { accountOf } from './session-info.js';
import { parseRollout } from './codex-rollout.js';
import { DISTIL_ENV } from './distil.js';
import {
  touchSession, pausePoller, runPoller, finishOnStop, flushResults, reportSession, noticeFor, leaveNotice,
  takeNotices, pollerAlive,
} from './bridge.js';

const BRIDGE_BIN = join(import.meta.dirname, '..', 'bin', 'bridge.js');
const QUEUE_TIMEOUT_MS = 30_000;
const TAIL_BYTES = 512 * 1024;

const str = (v) => (typeof v === 'string' && v ? v : null);

/** Starts `node bin/bridge.js <args>` detached from the hook, so it outlives it. */
export function spawnDetached(args, { env = process.env, spawnImpl = defaultSpawn, script = BRIDGE_BIN } = {}) {
  try {
    const child = spawnImpl(process.execPath, [script, ...args], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/** How to start codex without a shell: codex(.exe) on PATH, or on Windows the npm shim's bin/codex.js under Node. */
export function resolveCodex(env = process.env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const win = platform === 'win32';
  for (const d of dirs) {
    const exe = join(d, win ? 'codex.exe' : 'codex');
    if (existsSync(exe)) return { cmd: exe, pre: [] };
    if (win && existsSync(join(d, 'codex.cmd'))) {
      const js = join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(js)) return { cmd: process.execPath, pre: [js] };
    }
  }
  return null;
}

/** `codex queue --thread <id> --message <notice>`; true when codex took it (exit 0). */
export function queueIntoCodex(sessionId, notice, { env = process.env, spawnImpl = defaultSpawn, timeoutMs = QUEUE_TIMEOUT_MS } = {}) {
  const how = resolveCodex(env);
  if (!how) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(how.cmd, [...how.pre, 'queue', '--thread', sessionId, '--message', notice], { stdio: 'ignore', windowsHide: true, env });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** The last prompt of a Codex rollout (its tail), or null when none can be read. */
export function lastPromptOf(path) {
  if (!str(path)) return null;
  let text;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      for (const e of parseRollout(`${line}\n`).entries) if (e.kind === 'prompt') last = e.text;
    } catch {
      // a line this reader does not know is not a prompt
    }
  }
  return last;
}

function sessionOf(harness, input, env) {
  const sessionId = str(input?.session_id);
  if (!sessionId || env[DISTIL_ENV]) return null;
  const p = sessionPaths(harnessHome(harness), { sessionId, env, account: () => accountOf(harness, env) });
  return p.connection ? { p, sessionId } : null;
}

const touch = (s, harness, input, extra = {}) => touchSession(s.p, s.sessionId, { harness, cwd: str(input.cwd), transcriptPath: str(input.transcript_path), ...extra });

/**
 * The Claude Code hook (hooks/task-wait.js). Returns the exit code: 2 with the notice written to
 * `stderr` when a task arrived, else 0. Never throws for a session without a connection.
 */
export async function claudeHook(input, { env = process.env, stderr = process.stderr, fetchImpl = globalThis.fetch, spawnImpl = defaultSpawn } = {}) {
  const s = sessionOf('claude-code', input, env);
  if (!s) return 0;
  const event = str(input.hook_event_name) ?? 'Stop';
  if (event === 'UserPromptSubmit') {
    pausePoller(s.p, s.sessionId);
    touch(s, 'claude-code', input);
    return 0;
  }
  if (event === 'SessionEnd') {
    touch(s, 'claude-code', input, { closed: true });
    pausePoller(s.p, s.sessionId);
    spawnDetached(['report', '--harness', 'claude-code', '--session', s.sessionId], { env, spawnImpl });
    return 0;
  }
  if (event === 'Stop') finishOnStop(s.p, s.sessionId, { lastMessage: str(input.last_assistant_message) ?? '' });
  if (event === 'StopFailure') {
    const why = str(input.error) ?? str(input.error_type);
    finishOnStop(s.p, s.sessionId, { failed: true, lastMessage: str(input.last_assistant_message) ?? `The turn stopped on an error${why ? `: ${why.slice(0, 200)}` : ''}.` });
  }
  touch(s, 'claude-code', input);
  const out = await runPoller({ paths: s.p, sessionId: s.sessionId, runStatus: 'running', env, fetchImpl, onTasks: async () => 'stop' });
  if (out.exit !== 'stop') return 0;
  stderr.write(`${out.tasks.map(noticeFor).join('\n\n')}\n`);
  return 2;
}

/** Starts this Codex session's detached poller unless one is alive. */
export function ensureCodexPoller(p, sessionId, { env = process.env, spawnImpl = defaultSpawn } = {}) {
  if (pollerAlive(p, sessionId)) return false;
  return spawnDetached(['poll', '--harness', 'codex', '--session', sessionId], { env, spawnImpl });
}

/**
 * The Codex hook (hooks/bridge.js). Returns what to print on stdout: a Stop block with the notices
 * that could not be queued, or ''.
 */
export async function codexHook(input, { env = process.env, fetchImpl = globalThis.fetch, spawnImpl = defaultSpawn } = {}) {
  if (typeof input?.agent_id === 'string') return ''; // a spawned subagent's thread is not the person's
  const s = sessionOf('codex', input, env);
  if (!s) return '';
  const event = str(input.hook_event_name) ?? 'Stop';
  if (event === 'SessionEnd') {
    touch(s, 'codex', input, { closed: true });
    pausePoller(s.p, s.sessionId);
    spawnDetached(['report', '--harness', 'codex', '--session', s.sessionId], { env, spawnImpl });
    return '';
  }
  touch(s, 'codex', input);
  if (event === 'Stop') {
    finishOnStop(s.p, s.sessionId, { lastMessage: str(input.last_assistant_message) ?? '', turnPrompt: lastPromptOf(input.transcript_path) });
    await flushResults(s.p, s.sessionId, { fetchImpl });
  }
  ensureCodexPoller(s.p, s.sessionId, { env, spawnImpl });
  if (event !== 'Stop') return '';
  const notices = takeNotices(s.p, s.sessionId);
  return notices.length ? `${JSON.stringify({ decision: 'block', reason: notices.join('\n\n') })}\n` : '';
}

/** bin/bridge.js: `poll --harness codex --session <id>` (the detached Codex poller) or `report --harness <h> --session <id>`. */
export async function binMain(argv, { env = process.env, fetchImpl = globalThis.fetch, spawnImpl = defaultSpawn } = {}) {
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? str(rest[i + 1]) : null;
  };
  const harness = opt('harness');
  const sessionId = opt('session');
  if (!sessionId || (harness !== 'claude-code' && harness !== 'codex')) return 0;
  const p = sessionPaths(harnessHome(harness), { sessionId, env });
  if (!p.connection) return 0;
  if (cmd === 'report') {
    await reportSession(p, sessionId, { env, fetchImpl });
    return 0;
  }
  if (cmd === 'poll' && harness === 'codex') {
    await runPoller({
      paths: p, sessionId, runStatus: 'delivered', env, fetchImpl,
      onTasks: async (tasks) => {
        for (const task of tasks) {
          if (!(await queueIntoCodex(sessionId, noticeFor(task), { env, spawnImpl }))) leaveNotice(p, sessionId, task.id);
        }
        return 'continue';
      },
    });
  }
  return 0;
}
