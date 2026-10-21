// Distillation on the person's own machine (Oscar, 21.10: import = "the essence of their local
// sessions" plus answers to the colleague's questions, never raw sessions; the ongoing hooks send
// essence only; the distil runs as a headless `claude -p` in the background). A run reads local
// sessions and memory with Claude Code's own read tools and sends a short list of durable work facts,
// plus answers to the node's open questions, with `remember` (skills/distil/SKILL.md). Nothing raw
// leaves the machine; the plugin's MCP server redacts every argument before it is forwarded.
// Two triggers, one runner:
//   import   the node asked (portal «Importer»): a tool answer carries import_request.requested_at;
//            the run covers all local sources and closes the request with `import_of`
//   ongoing  the hooks note each transcript (noteSession); at most once per DISTIL_EVERY_HOURS a run
//            distils the noted transcripts
// The run itself has WYBE_CONNECT_DISTIL=1, so its own hooks and MCP server never start another run.
// It uses the person's own Claude Code subscription; nothing here calls a model directly.

import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonPrivate } from './home.js';

export const DISTIL_ENV = 'WYBE_CONNECT_DISTIL';
export const DISTIL_EVERY_HOURS = 6;
/** A run that has not finished after this long no longer blocks the next one. */
export const RUN_STALE_MS = 2 * 60 * 60 * 1000;
export const MAX_PENDING = 200;
export const ALLOWED_TOOLS = Object.freeze([
  'Read',
  'Glob',
  'Grep',
  'mcp__plugin_wybe-connect_wybe__remember',
  'mcp__plugin_wybe-connect_wybe__pending_questions',
]);

export const inDistilRun = (env = process.env) => env[DISTIL_ENV] === '1';

const statePath = (paths) => join(paths.state, 'distil.json');

export function loadState(paths) {
  const s = readJson(statePath(paths));
  return {
    importHandled: typeof s?.importHandled === 'string' ? s.importHandled : null,
    lastRunAt: typeof s?.lastRunAt === 'string' ? s.lastRunAt : null,
    running: s?.running && typeof s.running === 'object' ? s.running : null,
    pending: Array.isArray(s?.pending) ? s.pending : [],
  };
}

const saveState = (paths, state) => writeJsonPrivate(statePath(paths), state);

/** A hook saw this transcript: remember it for the next ongoing run (once per transcript). */
export function noteSession(paths, { transcriptPath, sessionId = null, cwd = null, now = Date.now() }) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return loadState(paths);
  const state = loadState(paths);
  const rest = state.pending.filter((p) => p.transcriptPath !== transcriptPath);
  rest.push({ transcriptPath, sessionId, cwd, at: new Date(now).toISOString() });
  state.pending = rest.slice(-MAX_PENDING);
  saveState(paths, state);
  return state;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

/**
 * What to run now, or null. An import the node asked for wins over the ongoing schedule; a run
 * still going (and younger than RUN_STALE_MS) blocks both.
 */
export function planRun(state, { now = Date.now(), importRequestedAt = null, everyHours = DISTIL_EVERY_HOURS, isAlive = alive } = {}) {
  if (state.running && now - Date.parse(state.running.startedAt) < RUN_STALE_MS && isAlive(state.running.pid)) return null;
  if (typeof importRequestedAt === 'string' && importRequestedAt && importRequestedAt !== state.importHandled) {
    return { mode: 'import', importOf: importRequestedAt };
  }
  const due = !state.lastRunAt || now - Date.parse(state.lastRunAt) >= everyHours * 60 * 60 * 1000;
  if (due && state.pending.length > 0) return { mode: 'ongoing', transcripts: state.pending.map((p) => p.transcriptPath) };
  return null;
}

export function buildPrompt(plan) {
  if (plan.mode === 'import') {
    return [
      'Use the wybe-connect `distil` skill.',
      'Mode: import (the person pressed «Importer» for this Claude Code in their Wybe portal).',
      `import_of: ${plan.importOf}`,
    ].join('\n');
  }
  return [
    'Use the wybe-connect `distil` skill.',
    'Mode: ongoing. Distil only these Claude Code transcripts:',
    ...plan.transcripts.map((t) => `- ${t}`),
  ].join('\n');
}

/** argv for the headless run: read-only local tools plus the two Wybe tools, nothing else. */
export function runArgs(plan, { model = process.env.WYBE_CONNECT_DISTIL_MODEL } = {}) {
  const args = ['-p', buildPrompt(plan), '--allowedTools', ALLOWED_TOOLS.join(','), '--output-format', 'text'];
  if (model) args.push('--model', model);
  return args;
}

/** Starts the headless run detached (it outlives the hook or server that started it) and records it. */
export function startRun(plan, { paths, now = Date.now(), spawnImpl = spawn, claudeBin = process.env.WYBE_CONNECT_CLAUDE_BIN || 'claude', cwd = homedir() } = {}) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const logPath = join(paths.state, `distil-${stamp}.log`);
  const fd = openSync(logPath, 'a', 0o600);
  let child;
  try {
    // A .js/.mjs "binary" runs under this Node (a wrapper, or the tests' recorder; never the real claude in tests).
    const script = /\.m?js$/i.test(claudeBin);
    child = spawnImpl(script ? process.execPath : claudeBin, script ? [claudeBin, ...runArgs(plan)] : runArgs(plan), {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, [DISTIL_ENV]: '1' },
    });
    child.on?.('error', () => {});
    child.unref?.();
  } finally {
    closeSync(fd);
  }
  const state = loadState(paths);
  state.running = { pid: child?.pid ?? null, startedAt: new Date(now).toISOString(), mode: plan.mode, log: logPath };
  state.lastRunAt = new Date(now).toISOString();
  if (plan.mode === 'import') state.importHandled = plan.importOf;
  else state.pending = state.pending.filter((p) => !plan.transcripts.includes(p.transcriptPath));
  saveState(paths, state);
  return state.running;
}

/** One call for every trigger: plan, and start when there is something to do. Never inside a run. */
export function maybeRun({ paths, importRequestedAt = null, env = process.env, now = Date.now(), spawnImpl, isAlive, everyHours } = {}) {
  if (inDistilRun(env)) return null;
  const plan = planRun(loadState(paths), { now, importRequestedAt, isAlive, everyHours });
  if (!plan) return null;
  startRun(plan, { paths, now, spawnImpl });
  return plan;
}

/** The node's import request in a tool answer (structuredContent, or the JSON text), or null. */
export function importRequestOf(result) {
  const fromStructured = result?.structuredContent?.import_request?.requested_at;
  if (typeof fromStructured === 'string') return fromStructured;
  const text = Array.isArray(result?.content) ? result.content.find((c) => c?.type === 'text')?.text : undefined;
  if (typeof text === 'string') {
    try {
      const at = JSON.parse(text)?.import_request?.requested_at;
      if (typeof at === 'string') return at;
    } catch {
      // prose, not JSON
    }
  }
  return null;
}
