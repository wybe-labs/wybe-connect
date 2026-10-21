// Distillation on the person's own machine (Oscar, 21.10: import = "the essence of their local
// sessions" plus answers to the colleague's questions, never raw sessions; the ongoing hooks send
// essence only; the distil runs as a headless `claude -p` in the background). A run reads local
// sessions and memory with read-only tools and sends a short list of durable work facts, plus
// answers to the node's open questions, with `remember` (skills/distil/SKILL.md). Nothing raw leaves
// the machine; the plugin's MCP server redacts every argument before it is forwarded.
//
// Two triggers, one runner:
//   import   the node asked (portal «Importer»): a tool answer carries import_request.requested_at;
//            the run covers all local sources and closes the request with `import_of`
//   ongoing  the hooks note each transcript (noteSession); at most once per DISTIL_EVERY_HOURS a run
//            distils the noted transcripts
//
// The node is not trusted with the run (QA round 1): the only thing it supplies, requested_at, must
// be a strict ISO 8601 timestamp or it is dropped, and the run is confined by the CLI itself:
// `--tools Read,Glob,Grep` (no Bash, Write, Edit, WebFetch, Task), `--strict-mcp-config` with only
// the plugin's own `wybe` server, `--permission-mode dontAsk`, `--max-turns`. A watchdog process
// (bin/distil-run.js → runWatchdog) owns each run: it kills it after RUN_TIMEOUT_MS and records the
// outcome. An import counts as handled only when the run exits 0; a failed one is retried after
// FAILURE_BACKOFF_MS. distil.json is only read-modified-written under a lock file.
// Every run has WYBE_CONNECT_DISTIL=1, so its own hooks and MCP server never start another run.

import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, writeSync, readSync, fstatSync, appendFileSync, mkdirSync, unlinkSync, statSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { readJson, writeJsonPrivate } from './home.js';

export const DISTIL_ENV = 'WYBE_CONNECT_DISTIL';
export const DISTIL_EVERY_HOURS = 6;
export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** A run older than this is presumed hung (its watchdog should have killed it at RUN_TIMEOUT_MS). */
export const RUN_STALE_MS = RUN_TIMEOUT_MS + 10 * 60 * 1000;
/** The back-off after a failure; it doubles per failure in a row, up to MAX_BACKOFF_MS. */
export const FAILURE_BACKOFF_MS = 30 * 60 * 1000;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const MAX_TURNS = 40;
export const MAX_PENDING = 2000;
/** A lock this old is checked: taken over only if its holder process is gone (QA R4-7). */
export const LOCK_STALE_MS = 5 * 1000;
/** A lock this old is taken over whatever (a holder's critical section is milliseconds). */
export const LOCK_MAX_MS = 10 * 60 * 1000;
/** How often one waiter opens an old lock to check its holder (cheap stat in between). */
export const LOCK_CHECK_MS = 250;
/** How long a run being started (recorded, no pid yet) blocks the next one. */
export const RESERVE_MS = 2 * 60 * 1000;
export const MAX_RUN_TRANSCRIPTS = 40;
/** And at most this many characters of paths per run, whatever their length (QA round 3). */
export const MAX_RUN_PATH_CHARS = 12000;
/** A backlog (more noted than one run takes) is worked off this often instead of every 6 h. */
export const BACKLOG_EVERY_MS = 30 * 60 * 1000;
/** How long a failed run is mentioned at SessionStart (QA R2-3). */
export const PROBLEM_SHOWN_DAYS = 7;
export const LOG_KEEP_DAYS = 14;
/** Built-in tools the run has at all (`--tools`), and what it may use without asking (`--allowedTools`). */
export const RUN_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
export const ALLOWED_TOOLS = Object.freeze([...RUN_TOOLS, 'mcp__wybe__remember', 'mcp__wybe__pending_questions']);

/** Strict ISO 8601 UTC-or-offset timestamp; anything else from the node is dropped. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export const isIsoTimestamp = (s) => typeof s === 'string' && s.length <= 40 && ISO.test(s) && !Number.isNaN(Date.parse(s));
const safePath = (s) => typeof s === 'string' && s.length > 0 && s.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(s);

const HERE = import.meta.dirname;
const PLUGIN_ROOT = join(HERE, '..');

export const inDistilRun = (env = process.env) => env[DISTIL_ENV] === '1';

const statePath = (paths) => join(paths.state, 'distil.json');

export function loadState(paths) {
  const s = readJson(statePath(paths));
  return {
    importHandled: typeof s?.importHandled === 'string' ? s.importHandled : null,
    lastRunAt: typeof s?.lastRunAt === 'string' ? s.lastRunAt : null,
    lastFailureAt: typeof s?.lastFailureAt === 'string' ? s.lastFailureAt : null,
    lastError: typeof s?.lastError === 'string' ? s.lastError : null,
    lastErrorKind: typeof s?.lastErrorKind === 'string' ? s.lastErrorKind : null,
    failures: Number.isInteger(s?.failures) ? s.failures : 0,
    problemShown: typeof s?.problemShown === 'string' ? s.problemShown : null,
    dropped: Number.isInteger(s?.dropped) ? s.dropped : 0,
    running: s?.running && typeof s.running === 'object' ? s.running : null,
    pending: Array.isArray(s?.pending) ? s.pending : [],
  };
}

/**
 * Pending, capped at MAX_PENDING without ever cutting `keep` (re-queued transcripts of a failed or
 * dead run, QA R4-6): the oldest of the others go first, and the drop is counted in state.dropped.
 */
function capPending(state, keep = []) {
  if (state.pending.length <= MAX_PENDING) return;
  const keepSet = new Set(keep);
  const before = state.pending.length;
  let over = before - MAX_PENDING;
  state.pending = state.pending.filter((p) => {
    if (over > 0 && !keepSet.has(p.transcriptPath)) {
      over -= 1;
      return false;
    }
    return true;
  });
  state.dropped += before - state.pending.length;
}

const saveState = (paths, state) => writeJsonPrivate(statePath(paths), state);

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A waiter's look at a lock older than LOCK_STALE_MS: unlinks it when its holder is gone, or when it
 * is older than LOCK_MAX_MS. Age and pid come from ONE handle (QA R4-7 round 5: a waiter that stat'ed
 * the old lock, then read the next holder's fresh and still empty one, deleted a live lock), an
 * empty lock counts as live, and the unlink happens only while the path still names that file.
 */
function takeOverIfDead(lock) {
  const fd = openSync(lock, 'r');
  let st;
  let text;
  try {
    st = fstatSync(fd);
    const buf = Buffer.alloc(32);
    text = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0));
  } finally {
    closeSync(fd);
  }
  const age = Date.now() - st.mtimeMs;
  if (age <= LOCK_STALE_MS) return;
  if (age <= LOCK_MAX_MS && (!/^\d+$/.test(text) || alive(Number(text)))) return;
  const now = statSync(lock);
  if (now.ino === st.ino && now.mtimeMs === st.mtimeMs && now.birthtimeMs === st.birthtimeMs) unlinkSync(lock);
}

/**
 * Runs fn() holding state/distil.lock (exclusive create, the holder's pid inside). A lock whose
 * holder is gone is taken over (takeOverIfDead). Busy after `tries` attempts → returns `busy`.
 */
export function withLock(paths, fn, { tries = 40, waitMs = 25, busy = null } = {}) {
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const lock = join(paths.state, 'distil.lock');
  let checkedAt = 0;
  for (let i = 0; i < tries; i++) {
    let fd;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (err) {
      // EPERM/EACCES on Windows: the lock was just unlinked while another waiter held a handle
      // (delete pending). Same meaning as EEXIST: someone else, retry (QA R2-7).
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(err?.code)) throw err;
      try {
        // A holder killed mid-hook leaves its lock behind. Waiters only stat a young lock (reading it
        // on every wait kept it delete-pending on Windows and starved the others), and open an old
        // one at most every LOCK_CHECK_MS. It is taken over only when the pid written in it is gone
        // (QA R4-7: taking a LIVE slow holder's lock let its late write erase other hooks' notes).
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS && Date.now() - checkedAt >= LOCK_CHECK_MS) {
          checkedAt = Date.now();
          takeOverIfDead(lock);
        }
      } catch {
        // gone already
      }
      pause(waitMs);
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        // removed by a stale-lock takeover
      }
    }
  }
  return busy;
}

/** A hook saw this transcript: remember it for the next ongoing run (once per transcript). */
export function noteSession(paths, { transcriptPath, sessionId = null, cwd = null, now = Date.now() }) {
  if (!safePath(transcriptPath)) return null;
  // Nothing is read outside the lock (QA R2-7: a lock-free read held distil.json open while the
  // holder renamed over it). Busy → null; the next Stop hook notes the same transcript again.
  return withLock(paths, () => {
    const state = loadState(paths);
    const rest = state.pending.filter((p) => p.transcriptPath !== transcriptPath);
    rest.push({ transcriptPath, sessionId, cwd, at: new Date(now).toISOString() });
    state.pending = rest;
    capPending(state);
    saveState(paths, state);
    return state;
  }, { tries: 400 });
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

/**
 * What to run now, or null. An import the node asked for wins over the ongoing schedule. A live run
 * blocks both until RUN_STALE_MS, a run being started (no pid yet) for RESERVE_MS; after that the
 * record is ignored, never acted on: a recorded pid is never killed (QA R2-4: after a reboot or a
 * crash it may belong to an unrelated process; a live run's own watchdog ends it at RUN_TIMEOUT_MS).
 * A failed run backs off FAILURE_BACKOFF_MS. An ongoing run takes at most MAX_RUN_TRANSCRIPTS, oldest
 * first, so its argv stays far below the Windows command-line limit (QA R2-2).
 */
/** 30 min after the first failure in a row, doubling per further failure, at most 6 h (QA round 4). */
export const backoffMs = (failures) => Math.min(MAX_BACKOFF_MS, FAILURE_BACKOFF_MS * 2 ** Math.max(0, (failures || 1) - 1));

export function planRun(state, { now = Date.now(), importRequestedAt = null, everyHours = DISTIL_EVERY_HOURS, isAlive = alive } = {}) {
  const r = state.running;
  if (r) {
    const age = now - Date.parse(r.startedAt);
    if (r.pid == null && age < RESERVE_MS) return null;
    if (r.pid != null && isAlive(r.pid) && age < RUN_STALE_MS) return null;
  }
  if (state.lastFailureAt && now - Date.parse(state.lastFailureAt) < backoffMs(state.failures)) return null;
  if (isIsoTimestamp(importRequestedAt) && importRequestedAt !== state.importHandled) {
    return { mode: 'import', importOf: importRequestedAt };
  }
  const since = state.lastRunAt ? now - Date.parse(state.lastRunAt) : Infinity;
  const backlog = state.pending.length > MAX_RUN_TRANSCRIPTS;
  const due = since >= everyHours * 60 * 60 * 1000 || (backlog && since >= BACKLOG_EVERY_MS);
  const transcripts = [];
  let chars = 0;
  for (const t of state.pending.map((p) => p.transcriptPath).filter(safePath)) {
    if (transcripts.length >= MAX_RUN_TRANSCRIPTS || (transcripts.length > 0 && chars + t.length > MAX_RUN_PATH_CHARS)) break;
    transcripts.push(t);
    chars += t.length;
  }
  if (due && transcripts.length > 0) return { mode: 'ongoing', transcripts };
  return null;
}

/** The distil instructions, inlined: the run has no Skill tool (`--tools` is Read, Glob, Grep). */
function skillText() {
  const p = join(PLUGIN_ROOT, 'skills', 'distil', 'SKILL.md');
  if (!existsSync(p)) return 'Distil the person\'s local Claude Code work into durable facts and send them with the `wybe` server\'s `remember` tool. Work only; never secrets, code, file contents or anything private.';
  return readFileSync(p, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim();
}

export function buildPrompt(plan, { instructions = skillText() } = {}) {
  const head = [instructions, '', '## This run'];
  if (plan.mode === 'import') {
    if (!isIsoTimestamp(plan.importOf)) throw new Error('import_of is not a timestamp');
    return [...head, 'Mode: import (the person pressed «Importer» for this Claude Code in their Wybe portal).', `import_of: ${plan.importOf}`].join('\n');
  }
  const transcripts = plan.transcripts.filter(safePath);
  return [...head, 'Mode: ongoing. Distil only these Claude Code transcripts:', ...transcripts.map((t) => `- ${t}`)].join('\n');
}

/** argv for the headless run: confined by the CLI, not by the prompt. */
export function runArgs(plan, { model = process.env.WYBE_CONNECT_DISTIL_MODEL, mcpServer = join(PLUGIN_ROOT, 'bin', 'mcp-proxy.js'), instructions } = {}) {
  const mcp = JSON.stringify({ mcpServers: { wybe: { command: process.execPath, args: [mcpServer] } } });
  const args = [
    '-p', buildPrompt(plan, instructions === undefined ? {} : { instructions }),
    '--tools', RUN_TOOLS.join(','),
    '--allowedTools', ALLOWED_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', mcp,
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'text',
  ];
  if (model) args.push('--model', model);
  return args;
}

/**
 * How to start `claude` without a shell: WYBE_CONNECT_CLAUDE_BIN (a .js/.mjs runs under this Node),
 * else `claude.exe` / `claude` on PATH, else the npm shim's cli.js run under this Node (Windows npm
 * installs only claude.cmd, which cannot be spawned without a shell). Null when none is found.
 */
export function resolveClaude({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const bin = env.WYBE_CONNECT_CLAUDE_BIN;
  if (bin) return /\.m?js$/i.test(bin) ? { cmd: process.execPath, pre: [bin] } : { cmd: bin, pre: [] };
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const names = platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const d of dirs) for (const n of names) if (exists(join(d, n))) return { cmd: join(d, n), pre: [] };
  for (const d of dirs) {
    if (!exists(join(d, platform === 'win32' ? 'claude.cmd' : 'claude'))) continue;
    for (const cli of ['cli.js', 'cli.mjs']) {
      const p = join(d, 'node_modules', '@anthropic-ai', 'claude-code', cli);
      if (exists(p)) return { cmd: process.execPath, pre: [p] };
    }
  }
  return null;
}

function pruneOld(paths, now) {
  try {
    for (const f of readdirSync(paths.state)) {
      if (!/^distil-(?:\d|plan-|ledger-)/.test(f)) continue;
      const p = join(paths.state, f);
      if (now - statSync(p).mtimeMs > LOG_KEEP_DAYS * 24 * 60 * 60 * 1000) unlinkSync(p);
    }
  } catch {
    // housekeeping only
  }
}

/**
 * Starts the watchdog for `plan` (detached; it outlives the hook or server that started it) and
 * records the run. Call under the lock. The run is recorded BEFORE the spawn (QA R2-8: a save that
 * failed after the spawn left a live run unrecorded, and the next hook started a second one); a
 * failed record throws before anything starts. Nothing is ever killed here (QA R2-4). A run that
 * could not be started is recorded as a failure, never as handled.
 */
export function startRun(plan, { paths, now = Date.now(), spawnImpl = spawn, runner = join(PLUGIN_ROOT, 'bin', 'distil-run.js') } = {}) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  pruneOld(paths, now);
  const planFile = join(paths.state, `distil-plan-${stamp}.json`);
  const logPath = join(paths.state, `distil-${stamp}.log`);
  writeJsonPrivate(planFile, { plan: { mode: plan.mode, importOf: plan.importOf ?? null, transcripts: plan.transcripts ?? null }, log: logPath, root: paths.root });
  const state = loadState(paths);
  // QA R3-7: a run whose watchdog died (reboot, crash) never recorded its end. Its transcripts go
  // back to pending before its record is replaced, so they are distilled after all.
  const orphaned = (state.running?.transcripts ?? []).filter(safePath).filter((t) => !state.pending.some((p) => p.transcriptPath === t));
  if (orphaned.length) {
    state.pending = [...orphaned.map((t) => ({ transcriptPath: t, sessionId: null, cwd: null, at: state.running.startedAt })), ...state.pending];
    capPending(state, orphaned);
  }
  state.running = { pid: null, startedAt: new Date(now).toISOString(), mode: plan.mode, importOf: plan.importOf ?? null, transcripts: plan.transcripts ?? null, log: logPath };
  if (plan.mode === 'ongoing') state.pending = state.pending.filter((p) => !plan.transcripts.includes(p.transcriptPath));
  saveState(paths, state);
  let child = null;
  try {
    child = spawnImpl(process.execPath, [runner, planFile], { cwd: homedir(), detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, WYBE_CONNECT_HOME: paths.root } });
    child?.on?.('error', () => {});
    child?.unref?.();
  } catch {
    child = null;
  }
  if (!Number.isInteger(child?.pid)) {
    state.running = null;
    if (plan.mode === 'ongoing') {
      state.pending = [...plan.transcripts.map((t) => ({ transcriptPath: t, sessionId: null, cwd: null, at: new Date(now).toISOString() })), ...state.pending];
      capPending(state, plan.transcripts);
    }
    state.lastFailureAt = new Date(now).toISOString();
    state.lastError = 'could not start the distil runner';
    state.lastErrorKind = 'runner-start';
    state.failures += 1;
    saveState(paths, state);
    return null;
  }
  state.running.pid = child.pid;
  saveState(paths, state);
  return state.running;
}

/** One call for every trigger: plan and start under the lock. Never inside a run. */
export function maybeRun({ paths, importRequestedAt = null, env = process.env, now = Date.now(), spawnImpl, isAlive, everyHours, runner } = {}) {
  if (inDistilRun(env)) return null;
  return withLock(paths, () => {
    const plan = planRun(loadState(paths), { now, importRequestedAt, isAlive, everyHours });
    if (!plan) return null;
    return startRun(plan, { paths, now, spawnImpl, runner }) ? plan : null;
  });
}

/**
 * The run's delivery ledger (QA R2-1, R3-3, R3-4): success is what reached the node, not claude's
 * exit code. The watchdog hands the run WYBE_CONNECT_LEDGER; the plugin's MCP server (inside the
 * run) appends one line per `remember` with whether the node took it and, for the call that
 * carried `import_of`, whether the node answered `import_done: true`.
 */
export const LEDGER_ENV = 'WYBE_CONNECT_LEDGER';
export const ledgerFor = (planFile) => planFile.replace(/distil-plan-([^/\\]*)\.json$/, 'distil-ledger-$1.jsonl');
export function recordDelivery(ledger, entry) {
  if (typeof ledger === 'string' && ledger) appendFileSync(ledger, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
/**
 * The ledger's entries. A line that does not parse (a torn append: disk full, the server killed
 * mid-write) is never skipped silently: it stands for a call that may not have reached the node
 * (QA R4-8: one torn line used to make the whole ledger read as empty, i.e. success).
 */
export function readLedger(ledger) {
  let text;
  try {
    text = readFileSync(ledger, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.trim()).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { tool: 'remember', ok: false, torn: true };
    }
  });
}

/**
 * Was the run a success, from the ledger? Fail closed (QA R4-3): the run must have reached the node
 * at least once (its first call is pending_questions; a node down at tools/list, or a signed-out
 * plugin, leaves nothing), every `remember` must have been delivered, and an import must have been
 * confirmed (import_done for its import_of). Null = success, else { kind, message }.
 */
export function ledgerVerdict(plan, entries) {
  if (!entries.some((e) => e.ok)) {
    return { kind: 'no-ack', message: 'the run never reached the node (offline, signed out, or no Wybe tools); retried later' };
  }
  const lost = entries.filter((e) => e.tool === 'remember' && !e.ok).length;
  if (lost > 0) return { kind: 'not-delivered', message: `${lost} remember call(s) did not reach the node; retried later` };
  if (plan.mode === 'import' && !entries.some((e) => e.ok && e.importDone && e.importOf === plan.importOf)) {
    return { kind: 'import-unconfirmed', message: 'the run ended without the node confirming the import (import_done); retried later' };
  }
  return null;
}

/**
 * QA R2-3 / R3-5 / R4-5: the last failure for SessionStart to tell the person, ONCE per KIND of
 * error (the text varies with call counts; problemShown records the kind that was told). Null when
 * there is nothing new to tell.
 */
export function distilProblem(paths, now = Date.now()) {
  try {
    const s = loadState(paths);
    if (!s.lastError || !s.lastFailureAt) return null;
    const kind = s.lastErrorKind ?? s.lastError;
    if (s.problemShown === kind) return null;
    if (now - Date.parse(s.lastFailureAt) > PROBLEM_SHOWN_DAYS * 24 * 60 * 60 * 1000) return null;
    return { error: s.lastError, kind, at: s.lastFailureAt };
  } catch {
    return null;
  }
}

/** SessionStart told the person about this kind of error: not again until another kind (or a success). */
export function markProblemShown(paths, kind) {
  withLock(paths, () => {
    const s = loadState(paths);
    if ((s.lastErrorKind ?? s.lastError) === kind) {
      s.problemShown = kind;
      saveState(paths, s);
    }
  });
}

function killTree(pid, platform = process.platform) {
  if (platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
}

/**
 * The watchdog (bin/distil-run.js): runs `claude -p` for the plan, kills it after `timeoutMs`, and
 * records the outcome under the lock. Resolves with { ok, code, error }.
 */
export function runWatchdog(planFile, { paths, spawnImpl = spawn, resolve = resolveClaude, timeoutMs = RUN_TIMEOUT_MS, now = Date.now, argsFor = runArgs } = {}) {
  const { plan, log } = readJson(planFile);
  const ledger = ledgerFor(planFile);
  const finish = (outcome) => {
    if (outcome.ok) {
      const verdict = ledgerVerdict(plan, readLedger(ledger));
      if (verdict) outcome = { ok: false, code: outcome.code, kind: verdict.kind, error: verdict.message };
    }
    withLock(paths, () => {
      const state = loadState(paths);
      if (state.running?.pid === process.pid) state.running = null;
      if (outcome.ok) {
        // Only a success moves the schedule (QA R3-6: a failure that set lastRunAt pushed the next
        // try 6 h out, past the 30-minute back-off).
        state.lastRunAt = new Date(now()).toISOString();
        if (plan.mode === 'import') state.importHandled = plan.importOf;
        state.lastFailureAt = null;
        state.lastError = null;
        state.lastErrorKind = null;
        state.failures = 0;
        state.problemShown = null;
      } else {
        state.lastFailureAt = new Date(now()).toISOString();
        state.lastError = String(outcome.error ?? `exit ${outcome.code}`).slice(0, 200);
        state.lastErrorKind = outcome.kind ?? 'run-failed';
        state.failures += 1;
        if (plan.mode === 'ongoing') {
          const back = (plan.transcripts ?? []).filter(safePath);
          const known = new Set(state.pending.map((p) => p.transcriptPath));
          state.pending = [...back.filter((t) => !known.has(t)).map((t) => ({ transcriptPath: t, sessionId: null, cwd: null, at: state.lastFailureAt })), ...state.pending];
          capPending(state, back);
        }
      }
      saveState(paths, state);
    }, { tries: 400 });
    for (const f of [planFile, ledger]) {
      try {
        unlinkSync(f);
      } catch {
        // kept for the log pruner
      }
    }
    return outcome;
  };
  const claude = resolve();
  if (!claude) return Promise.resolve(finish({ ok: false, kind: 'claude-not-found', error: 'claude not found on PATH (set WYBE_CONNECT_CLAUDE_BIN)' }));
  return new Promise((done) => {
    let fd = null;
    let settled = false;
    let timer = null;
    const settle = (o) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fd !== null) closeSync(fd);
      done(finish(o));
    };
    let child;
    try {
      fd = openSync(log, 'a', 0o600);
      child = spawnImpl(claude.cmd, [...claude.pre, ...argsFor(plan)], {
        cwd: homedir(), windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', fd, fd], env: { ...process.env, [DISTIL_ENV]: '1', WYBE_CONNECT_HOME: paths.root, [LEDGER_ENV]: ledger },
      });
    } catch (err) {
      settle({ ok: false, kind: 'spawn', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    timer = setTimeout(() => {
      if (Number.isInteger(child.pid)) killTree(child.pid);
      settle({ ok: false, kind: 'timeout', error: `timed out after ${Math.round(timeoutMs / 60000)} min` });
    }, timeoutMs);
    child.on('error', (err) => settle({ ok: false, kind: 'spawn', error: err?.code ?? err?.message ?? 'spawn error' }));
    child.on('exit', (code) => settle(code === 0 ? { ok: true, code } : { ok: false, kind: 'exit', code }));
  });
}

/** The node's import request in a tool answer (structuredContent, or the JSON text), or null. Only a strict timestamp passes. */
export function importRequestOf(result) {
  const fromStructured = result?.structuredContent?.import_request?.requested_at;
  if (fromStructured !== undefined) return isIsoTimestamp(fromStructured) ? fromStructured : null;
  const text = Array.isArray(result?.content) ? result.content.find((c) => c?.type === 'text')?.text : undefined;
  if (typeof text === 'string') {
    try {
      const at = JSON.parse(text)?.import_request?.requested_at;
      return isIsoTimestamp(at) ? at : null;
    } catch {
      // prose, not JSON
    }
  }
  return null;
}
