// Reads a Codex CLI rollout (the file a Codex hook names in `transcript_path`) into the same
// classified entries lib/transcript.js produces for Claude Code, so buildSession() and its
// light-payload trap serve both harnesses unchanged.
//
// Where the shape comes from (verified 2026-09-29, not from memory):
//   - openai/codex @ 0462dcc0 (main, 2026-09-29): codex-rs/rollout/src/policy.rs decides what is
//     persisted; codex-rs/core/src/session/mod.rs `hook_transcript_path()` = the rollout path;
//     codex-rs/protocol/src/protocol.rs UserMessageEvent / PatchApplyEndEvent / SessionSource.
//   - A structural census (key paths and value TYPES only, no content read) of 24 real rollouts
//     written by Codex 0.153.4, 0.154.0-alpha.6.2 and 0.155.0-alpha.9.2 on the maintainer's laptop.
//
// One JSON object per line: { timestamp, ordinal?, type, payload }.
//   session_meta   first line: { id, session_id, cwd, cli_version, source, history_mode,
//                  git: { branch, commit_hash, repository_url } }. `source` is a string for a
//                  person's thread ("cli", "vscode", "exec", ...) and an OBJECT for a spawned
//                  subagent ({subagent: ...}) or an internal job ({internal: ...}).
//   turn_context   per turn: { turn_id, cwd, model, ... }
//   response_item  the model history, persisted in every history mode:
//                  message {role: developer|user|assistant, content: [input_text|output_text|input_image]},
//                  reasoning, function_call {name, arguments: JSON string, call_id},
//                  custom_tool_call {name, input: string, call_id}, *_output {call_id, output},
//                  agent_message (inter-agent), compaction, ...
//   event_msg      UI events. What the PERSON typed is here, never in response_item (whose
//                  role=user messages also carry AGENTS.md, <environment_context> and other
//                  harness-injected text): `user_message {message}` in legacy history mode,
//                  `item_completed {item: {type: "UserMessage", content: [{type: "text", text}]}}`
//                  in paginated mode. policy.rs persists exactly one of the two per rollout.
//                  Files changed: `item_completed` FileChange {changes: {<abs path>: ...}}
//                  (paginated) or `patch_apply_end {changes: {<path>: ...}}` (legacy).
//   compacted, world_state, token_usage_record, ... bookkeeping; never reported.
//
// What becomes what:
//   prompt          the person's own message (event_msg only)
//   assistant-text  response_item message role=assistant (commentary and final answers)
//   tool-use        function_call / custom_tool_call / local_shell_call
//   tool-result     *_call_output, joined by call_id
//   thinking        reasoning (never leaves the machine; only counted)
//   context         developer messages and inter-agent messages: never sent, and the light
//                   trap searches for them
//   file-change     one per path touched (FileChange, patch_apply_end, apply_patch input)
//   other           everything else, including the model-side copy of user input

import { openSync, readSync, closeSync } from 'node:fs';

export const KNOWN_TYPES = new Set([
  // observed in real rollouts (census above)
  'session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted', 'world_state',
  'inter_agent_communication_metadata', 'token_usage_record',
  // RolloutItem variants in policy.rs not seen in the census; names inferred (snake_case)
  'inter_agent_communication', 'retained_context', 'security_risk_score', 'realtime_item',
]);

// ResponseItem variants persisted by policy.rs `should_persist_response_item`, snake_case.
const RESPONSE_TYPES = new Set([
  'message', 'agent_message', 'reasoning', 'local_shell_call', 'function_call', 'tool_search_call',
  'function_call_output', 'tool_search_output', 'custom_tool_call', 'custom_tool_call_output',
  'web_search_call', 'image_generation_call', 'configuration_update', 'compaction', 'context_compaction',
]);

const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/**
 * The first line of a rollout: who wrote it and for whom. Reads at most 256 KiB (session_meta
 * carries the base instructions and can be large). `personThread` is false for a spawned
 * subagent or an internal job: nothing from such a file is ever reported.
 */
export function rolloutHead(path) {
  const fd = openSync(path, 'r');
  let text;
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  return headOf(JSON.parse(text.slice(0, nl)));
}

export function headOf(first) {
  if (first?.type !== 'session_meta' || typeof first.payload !== 'object') return null;
  const p = first.payload;
  const source = p.source;
  const personThread = typeof source === 'string' || source === undefined || (typeof source === 'object' && source !== null && !('subagent' in source) && !('internal' in source));
  return {
    sessionId: typeof p.id === 'string' ? p.id : typeof p.session_id === 'string' ? p.session_id : null,
    cwd: typeof p.cwd === 'string' ? p.cwd : null,
    branch: typeof p.git?.branch === 'string' ? p.git.branch : null,
    cliVersion: typeof p.cli_version === 'string' ? p.cli_version : null,
    historyMode: typeof p.history_mode === 'string' ? p.history_mode : null,
    personThread,
  };
}

/**
 * Parses rollout JSONL into classified entries (see lib/transcript.js for the entry shape).
 * `head` (from rolloutHead) supplies session id, cwd and branch for a delta that does not
 * start at the first line. strict=true throws on an unknown line or response_item type (tests);
 * the hooks run lenient and count them. A malformed LAST line is a partial tail.
 */
export function parseRollout(text, { strict = false, head = null } = {}) {
  const entries = [];
  const unknownTypes = new Map();
  const lines = text.split('\n');
  let partialTail = '';
  const ctx = {
    cwd: head?.cwd ?? null,
    sessionId: head?.sessionId ?? null,
    branch: head?.branch ?? null,
    sidechain: head ? !head.personThread : false,
  };
  const unknown = (name) => unknownTypes.set(name, (unknownTypes.get(name) ?? 0) + 1);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) {
        partialTail = line;
        continue;
      }
      throw new Error(`rollout: malformed JSON on line ${i + 1}`);
    }
    if (typeof obj !== 'object' || obj === null || typeof obj.type !== 'string') {
      throw new Error(`rollout: line ${i + 1} is not an object with a string type`);
    }
    if (!KNOWN_TYPES.has(obj.type)) {
      if (strict) throw new Error(`rollout: unknown line type "${obj.type}" on line ${i + 1}`);
      unknown(obj.type);
      continue;
    }
    const p = obj.payload ?? {};
    if (obj.type === 'session_meta') {
      const h = headOf(obj);
      if (h) {
        ctx.cwd = h.cwd ?? ctx.cwd;
        ctx.sessionId = ctx.sessionId ?? h.sessionId;
        ctx.branch = h.branch ?? ctx.branch;
        if (!h.personThread) ctx.sidechain = true;
      }
    } else if (obj.type === 'turn_context' && typeof p.cwd === 'string') {
      ctx.cwd = p.cwd;
    }
    const base = { at: typeof obj.timestamp === 'string' ? obj.timestamp : null, cwd: ctx.cwd, sessionId: ctx.sessionId, branch: ctx.branch, sidechain: ctx.sidechain };
    if (obj.type === 'response_item') {
      if (!RESPONSE_TYPES.has(p.type)) {
        if (strict) throw new Error(`rollout: unknown response_item type "${p.type}" on line ${i + 1}`);
        unknown(`response_item/${p.type}`);
        continue;
      }
      for (const e of classifyResponse(p, base)) entries.push(e);
    } else if (obj.type === 'event_msg') {
      for (const e of classifyEvent(p, base)) entries.push(e);
    } else {
      entries.push({ ...base, kind: 'other', type: obj.type });
    }
  }
  return { entries, unknownTypes: Object.fromEntries(unknownTypes), partialTail };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b?.text === 'string' ? b.text : b?.type === 'input_image' || b?.type === 'local_image' || b?.type === 'image' ? '[image attached]' : ''))
    .filter(Boolean)
    .join('\n');
}

function parseArgs(s) {
  if (typeof s !== 'string') return s ?? {};
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === 'object' ? v : { arguments: s };
  } catch {
    return { arguments: s };
  }
}

function classifyResponse(p, base) {
  switch (p.type) {
    case 'message':
      if (p.role === 'assistant') {
        const text = textOf(p.content);
        return text ? [{ ...base, kind: 'assistant-text', text }] : [];
      }
      if (p.role === 'developer' || p.role === 'system') return [{ ...base, kind: 'context', text: textOf(p.content) }];
      // role=user here is the MODEL-side copy: the person's text plus AGENTS.md,
      // <environment_context> and other injected blocks. The person's prompt is taken from
      // event_msg instead, so nothing here is ever reported.
      return [{ ...base, kind: 'other', type: 'model-input' }];
    case 'agent_message':
      return [{ ...base, kind: 'context', text: textOf(p.content) }];
    case 'reasoning':
      return [{ ...base, kind: 'thinking' }];
    case 'function_call':
      return [{ ...base, kind: 'tool-use', toolUseId: p.call_id ?? null, name: String(p.name ?? ''), input: parseArgs(p.arguments) }];
    case 'custom_tool_call': {
      const out = [{ ...base, kind: 'tool-use', toolUseId: p.call_id ?? null, name: String(p.name ?? ''), input: { input: typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? null) } }];
      if (p.name === 'apply_patch' && typeof p.input === 'string') {
        for (const path of patchPaths(p.input)) out.push({ ...base, kind: 'file-change', path: absolutise(path, base.cwd) });
      }
      return out;
    }
    case 'local_shell_call':
      return [{ ...base, kind: 'tool-use', toolUseId: p.call_id ?? p.id ?? null, name: 'local_shell', input: p.action ?? {} }];
    case 'function_call_output':
    case 'custom_tool_call_output':
      return [{ ...base, kind: 'tool-result', toolUseId: p.call_id ?? null, text: outputText(p.output) }];
    default:
      return [{ ...base, kind: 'other', type: `response_item/${p.type}` }];
  }
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return textOf(output);
  if (output && typeof output === 'object' && typeof output.content === 'string') return output.content;
  return output === undefined || output === null ? '' : JSON.stringify(output);
}

function classifyEvent(p, base) {
  if (p.type === 'user_message' && typeof p.message === 'string') {
    const text = stripCodexInjected(p.message);
    return text ? [{ ...base, kind: 'prompt', text, meta: false }] : [];
  }
  if (p.type === 'item_completed' && p.item && typeof p.item === 'object') {
    if (p.item.type === 'UserMessage') {
      const text = stripCodexInjected(textOf(p.item.content ?? []));
      return text ? [{ ...base, kind: 'prompt', text, meta: false }] : [];
    }
    if (p.item.type === 'FileChange' && p.item.changes && typeof p.item.changes === 'object') {
      return Object.keys(p.item.changes).map((path) => ({ ...base, kind: 'file-change', path: absolutise(path, base.cwd) }));
    }
  }
  if (p.type === 'patch_apply_end' && p.changes && typeof p.changes === 'object' && p.success !== false) {
    return Object.keys(p.changes).map((path) => ({ ...base, kind: 'file-change', path: absolutise(path, base.cwd) }));
  }
  return [{ ...base, kind: 'other', type: `event_msg/${p.type}` }];
}

// The Codex desktop app and IDE extension wrap the person's words: leading XML-ish blocks
// (<in-app-browser-context>, <heartbeat> for automations, <send_user_message_question_reply>
// that quotes the assistant's own question) and a markdown template whose headers name attached
// files and open editor tabs, ending in "## My request:" (desktop app, seen in the census) or
// "## My request for Codex:" (IDE extension). Found by the census (tag names and headers only).
// Everything before the person's own words goes; a turn that is nothing but wrapping is
// dropped. Tags INSIDE the person's text are left alone.
const LEADING_BLOCK = /^<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/;
const IDE_TEMPLATE = /^# (?:Files mentioned by the user|Context from my IDE setup):/;
const MY_REQUEST = /^## My request(?: for Codex)?:[^\S\n]*\n?/m;

export function stripCodexInjected(text) {
  let t = String(text).trim();
  for (let m = LEADING_BLOCK.exec(t); m; m = LEADING_BLOCK.exec(t)) t = t.slice(m[0].length).trim();
  if (IDE_TEMPLATE.test(t) || /^## My request(?: for Codex)?:/.test(t)) {
    const m = MY_REQUEST.exec(t);
    t = m ? t.slice(m.index + m[0].length).trim() : '';
  }
  return t;
}

export function patchPaths(patch) {
  const paths = [];
  for (const m of patch.matchAll(PATCH_FILE_LINE)) paths.push((m[1] ?? m[2]).trim());
  return paths;
}

function absolutise(path, cwd) {
  if (!cwd || /^([A-Za-z]:[\\/]|[\\/])/.test(path)) return path;
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${path.replace(/^\.[\\/]/, '')}`;
}
