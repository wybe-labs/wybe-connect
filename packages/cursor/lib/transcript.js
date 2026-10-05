// Reads Claude Code's transcript JSONL and builds the scope-aware report_session payload.
//
// Shape of the file (observed 2026-09-22 on Claude Code 2.x): one JSON object per line. Turns
// carry `type` user|assistant, `uuid`, `parentUuid`, `timestamp`, `cwd`, `sessionId`, `gitBranch`,
// `isSidechain` (a subagent's thread: its "user" turns are written by the assistant, not the
// person) and sometimes `isMeta` (harness-injected). `message.content` is a string or an array of
// blocks: text, thinking, tool_use {id, name, input}, tool_result {tool_use_id, content}. Other
// line types are bookkeeping (custom-title, file-history-snapshot, last-prompt, ...).
//
// Two payloads, chosen by the granted scope:
//   sessions:light  project (cwd basename + git remote NAMES), branch, files touched, duration,
//                   and the person's OWN prompts. Zero assistant text; enforced by a trap.
//   sessions:full   the same plus every assistant text block and tool call/result (bounded).
// Thinking blocks never leave the machine under either scope.

import { readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { basename, join, isAbsolute, resolve, dirname } from 'node:path';

export const KNOWN_TYPES = new Set([
  'user', 'assistant', 'system', 'attachment', 'summary', 'custom-title', 'agent-name', 'mode',
  'atis-latch', 'file-history-snapshot', 'file-history-delta', 'queue-operation', 'last-prompt',
  'pr-link',
]);

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const DEFAULT_TOOL_CHARS = 4000;

/**
 * Parses JSONL text into classified entries.
 * strict=true throws on a line type it does not know (tests run strict); the hooks run lenient
 * and report the unknown types, because Claude Code adds bookkeeping types between releases and
 * a flush that dies on one of them would silently stop reporting.
 * The last line may be partial (the hook can fire while Claude Code is still writing); it is
 * returned in `partialTail` and not consumed, so the cursor never advances past it.
 */
export function parseTranscript(text, { strict = false } = {}) {
  const entries = [];
  const unknownTypes = new Map();
  const lines = text.split('\n');
  let partialTail = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      if (i === lines.length - 1) {
        partialTail = line;
        continue;
      }
      throw new Error(`transcript: malformed JSON on line ${i + 1}`);
    }
    if (typeof obj !== 'object' || obj === null || typeof obj.type !== 'string') {
      throw new Error(`transcript: line ${i + 1} is not an object with a string type`);
    }
    if (!KNOWN_TYPES.has(obj.type)) {
      if (strict) throw new Error(`transcript: unknown line type "${obj.type}" on line ${i + 1}`);
      unknownTypes.set(obj.type, (unknownTypes.get(obj.type) ?? 0) + 1);
      continue;
    }
    for (const e of classify(obj)) entries.push(e);
  }
  return { entries, unknownTypes: Object.fromEntries(unknownTypes), partialTail };
}

function classify(obj) {
  const base = {
    at: typeof obj.timestamp === 'string' ? obj.timestamp : null,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
    branch: typeof obj.gitBranch === 'string' ? obj.gitBranch : null,
    sidechain: obj.isSidechain === true,
  };
  if (obj.type !== 'user' && obj.type !== 'assistant') return [{ ...base, kind: 'other', type: obj.type }];
  const content = obj.message?.content;
  const out = [];
  if (obj.type === 'user') {
    if (typeof content === 'string') {
      out.push({ ...base, kind: 'prompt', text: content, meta: obj.isMeta === true });
    } else if (Array.isArray(content)) {
      const texts = [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block?.type === 'tool_result') out.push({ ...base, kind: 'tool-result', toolUseId: block.tool_use_id ?? null, text: resultText(block.content) });
        else if (block?.type === 'image' || block?.type === 'document') texts.push(`[${block.type} attached]`);
        else throw new Error(`transcript: unknown user block type "${block?.type}"`);
      }
      if (texts.length) out.push({ ...base, kind: 'prompt', text: texts.join('\n'), meta: obj.isMeta === true });
    } else {
      throw new Error('transcript: user entry without message.content');
    }
    return out;
  }
  if (!Array.isArray(content)) {
    if (typeof content === 'string') return [{ ...base, kind: 'assistant-text', text: content }];
    throw new Error('transcript: assistant entry without message.content');
  }
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out.push({ ...base, kind: 'assistant-text', text: block.text });
    else if (block?.type === 'tool_use') out.push({ ...base, kind: 'tool-use', toolUseId: block.id ?? null, name: String(block.name ?? ''), input: block.input ?? {} });
    else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') out.push({ ...base, kind: 'thinking' });
    else throw new Error(`transcript: unknown assistant block type "${block?.type}"`);
  }
  return out;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : `[${b?.type ?? 'unknown'} block]`))
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/**
 * Reads the bytes appended since `offset`, stopping at the last newline so a partial line is
 * left for the next flush. If the file is now shorter than the offset it was rewritten, and the
 * read restarts from zero. Returns { text, nextOffset, restarted }.
 */
export function readDelta(path, offset = 0) {
  const size = statSync(path).size;
  const restarted = offset > size;
  const start = restarted ? 0 : offset;
  if (size === start) return { text: '', nextOffset: start, restarted };
  const fd = openSync(path, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { text: '', nextOffset: start, restarted };
  return { text: buf.subarray(0, lastNl + 1).toString('utf8'), nextOffset: start + lastNl + 1, restarted };
}

/** Remote NAMES from the repository's .git/config (never URLs, never the userinfo in them). */
export function gitRemoteNames(cwd) {
  try {
    const config = findGitConfig(cwd);
    if (!config) return [];
    const names = [];
    for (const m of readFileSync(config, 'utf8').matchAll(/^\s*\[remote "([^"\]]+)"\]/gm)) names.push(m[1]);
    return names;
  } catch {
    return [];
  }
}

function findGitConfig(cwd) {
  const dotGit = join(cwd, '.git');
  if (!existsSync(dotGit)) return null;
  const st = statSync(dotGit);
  if (st.isDirectory()) return join(dotGit, 'config');
  const gitdirLine = readFileSync(dotGit, 'utf8').split('\n').find((l) => l.startsWith('gitdir:'));
  if (!gitdirLine) return null;
  let gitdir = gitdirLine.slice('gitdir:'.length).trim();
  if (!isAbsolute(gitdir)) gitdir = resolve(cwd, gitdir);
  const commondir = join(gitdir, 'commondir');
  if (existsSync(commondir)) {
    let common = readFileSync(commondir, 'utf8').trim();
    if (!isAbsolute(common)) common = resolve(gitdir, common);
    return join(common, 'config');
  }
  return join(dirname(gitdir), 'config');
}

/**
 * The checked-out branch from HEAD (a worktree's own HEAD lives in its gitdir), or null when
 * detached or not a repository. For harnesses whose hooks do not name the branch (Cursor).
 */
export function gitBranch(cwd) {
  try {
    const dotGit = join(cwd, '.git');
    if (!existsSync(dotGit)) return null;
    let gitdir = dotGit;
    if (!statSync(dotGit).isDirectory()) {
      const line = readFileSync(dotGit, 'utf8').split('\n').find((l) => l.startsWith('gitdir:'));
      if (!line) return null;
      gitdir = line.slice('gitdir:'.length).trim();
      if (!isAbsolute(gitdir)) gitdir = resolve(cwd, gitdir);
    }
    const m = /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(gitdir, 'HEAD'), 'utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export function stripInjected(text) {
  return text.replace(SYSTEM_REMINDER, '').trim();
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
}

/**
 * Builds the report_session payload (wire shape, snake_case) from parsed entries.
 * scope: 'sessions:light' | 'sessions:full'
 */
export function buildSession(entries, { scope, sessionId = null, transcriptId = null, cwd = null, gitRemotes = [], maxToolChars = DEFAULT_TOOL_CHARS, harness = 'claude-code' }) {
  if (scope !== 'sessions:light' && scope !== 'sessions:full') throw new Error(`buildSession: unknown scope ${scope}`);
  const main = entries.filter((e) => !e.sidechain);
  const firstCwd = cwd ?? main.find((e) => e.cwd)?.cwd ?? null;
  const branch = main.map((e) => e.branch).filter(Boolean).at(-1) ?? null;
  const times = main.map((e) => e.at).filter(Boolean).sort();
  const startedAt = times[0] ?? null;
  const endedAt = times.at(-1) ?? null;
  const durationS = startedAt && endedAt ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)) : null;

  const files = new Set();
  for (const e of main) {
    if (e.kind === 'tool-use' && FILE_TOOLS.has(e.name)) {
      const p = e.input?.file_path ?? e.input?.notebook_path;
      if (typeof p === 'string') files.add(p);
    }
    // other harnesses' readers name the touched paths directly (lib/codex-rollout.js, lib/cursor-spool.js)
    if (e.kind === 'file-change' && typeof e.path === 'string') files.add(e.path);
  }

  const prompts = main
    .filter((e) => e.kind === 'prompt' && !e.meta)
    .map((e) => ({ at: e.at, text: stripInjected(e.text) }))
    .filter((p) => p.text.length > 0);

  const payload = {
    scope,
    harness,
    session_id: sessionId ?? main.find((e) => e.sessionId)?.sessionId ?? null,
    transcript_id: transcriptId,
    project: {
      name: firstCwd ? basename(firstCwd) : null,
      git_remotes: [...gitRemotes],
      branch,
    },
    started_at: startedAt,
    ended_at: endedAt,
    duration_s: durationS,
    files_touched: [...files].sort(),
    prompts,
    counts: {
      prompts: prompts.length,
      assistant_turns: main.filter((e) => e.kind === 'assistant-text').length,
      tool_calls: main.filter((e) => e.kind === 'tool-use').length,
    },
  };

  if (scope === 'sessions:full') {
    const results = new Map(main.filter((e) => e.kind === 'tool-result').map((e) => [e.toolUseId, e]));
    const turns = [];
    for (const e of main) {
      if (e.kind === 'prompt' && !e.meta) {
        const text = stripInjected(e.text);
        if (text) turns.push({ role: 'user', at: e.at, text });
      } else if (e.kind === 'assistant-text') {
        turns.push({ role: 'assistant', at: e.at, text: e.text });
      } else if (e.kind === 'tool-use') {
        const r = results.get(e.toolUseId);
        turns.push({ role: 'tool', at: e.at, tool: { name: e.name, input: clip(JSON.stringify(e.input), maxToolChars), output: r ? clip(r.text, maxToolChars) : null } });
      }
    }
    payload.turns = turns;
  } else {
    assertLightIsClean(payload, entries);
  }
  return payload;
}

/**
 * The trap: a light payload must carry no assistant text at all. Every assistant text block,
 * every tool input/output, every subagent prompt and every harness-injected context block
 * (developer/inter-agent messages, kind 'context') of the source entries is searched for in the
 * serialised payload; any hit throws. Called on every light build, so an omission upstream cannot pass silently.
 */
export function assertLightIsClean(payload, entries) {
  const serialised = JSON.stringify(payload);
  for (const e of entries) {
    const fragments = [];
    if (e.kind === 'assistant-text') fragments.push(e.text);
    if (e.kind === 'tool-result') fragments.push(e.text);
    if (e.kind === 'tool-use') fragments.push(JSON.stringify(e.input));
    if (e.kind === 'prompt' && e.sidechain) fragments.push(e.text);
    if (e.kind === 'context' && typeof e.text === 'string') fragments.push(e.text);
    for (const f of fragments) {
      const probe = f.length > 24 ? f.slice(0, 24) : f;
      if (probe.length >= 8 && serialised.includes(JSON.stringify(probe).slice(1, -1))) {
        throw new Error(`light payload carried ${e.kind} content; refusing to send`);
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'turns')) throw new Error('light payload carried turns; refusing to send');
}
