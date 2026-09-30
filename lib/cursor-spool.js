// The Cursor adapter. Cursor's hooks hand over what happened as it happens (documented payloads:
// https://cursor.com/docs/agent/hooks, read 2026-09-29), while its transcript file is optional
// ("when transcripts enabled") and its format is not documented. So this adapter never reads the
// transcript: each hook appends ONE redacted record to a per-conversation spool, and `stop`
// turns the spool into the same entries lib/transcript.js builds payloads from.
//
//   beforeSubmitPrompt {prompt}                  -> prompt          (sessions:light and full)
//   afterFileEdit      {file_path}               -> file-change     (the path only, never the edit)
//   afterAgentResponse {text}                    -> assistant-text  (sessions:full ONLY)
//   postToolUse        {tool_name, tool_input, tool_output, tool_use_id} -> tool-use + tool-result (full ONLY)
//   afterAgentThought  is not registered: thinking never leaves the machine.
//
// The scope is checked when a record is WRITTEN: under sessions:light an assistant reply or a
// tool call is never even spooled. Every record is redacted before it touches the disk
// (the README's promise), and the payload is redacted again at flush (idempotent).
//
// Common fields on every hook: conversation_id, generation_id, hook_event_name,
// workspace_roots[], transcript_path (not used). sessionStart/sessionEnd also carry session_id.

import { mkdirSync, appendFileSync, readFileSync, readdirSync, renameSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCredentials, readJson, writeJsonPrivate } from './home.js';
import { redactValue } from './redact.js';
import { buildSession, gitRemoteNames, gitBranch } from './transcript.js';
import { sessionScopeOf, createDelivery, newSummary, mergeHits } from './flush.js';
import { size as queueSize } from './queue.js';

export const FOLLOWUP_MARKER = '[wybe-connect]';
export const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
export const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const QUESTION_BACKOFF_MS = 14 * 24 * 60 * 60 * 1000;
const CLIP = 4000;

const clip = (s) => (s.length > CLIP ? `${s.slice(0, CLIP)}…[+${s.length - CLIP} chars]` : s);
const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

export function conversationIdOf(input) {
  const id = input?.conversation_id ?? input?.session_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function spoolFile(paths, conversationId) {
  return join(paths.spool, `${safeId(conversationId)}.jsonl`);
}

/** The record a hook payload becomes under `scope`, or null when nothing may be kept. */
export function recordOf(input, scope, now) {
  const base = { at: new Date(now).toISOString(), cwd: Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === 'string' ? input.workspace_roots[0] : null };
  switch (input.hook_event_name) {
    case 'beforeSubmitPrompt':
      if (typeof input.prompt !== 'string' || input.prompt.trim() === '') return null;
      // our own stop followup is submitted as a user message; it is not the person's prompt
      if (input.prompt.trimStart().startsWith(FOLLOWUP_MARKER)) return null;
      return { ...base, kind: 'prompt', text: input.prompt };
    case 'afterFileEdit':
      return typeof input.file_path === 'string' ? { ...base, kind: 'file', path: input.file_path } : null;
    case 'afterAgentResponse':
      if (scope !== 'sessions:full' || typeof input.text !== 'string') return null;
      return { ...base, kind: 'assistant-text', text: input.text };
    case 'postToolUse': {
      if (scope !== 'sessions:full') return null;
      const raw = input.tool_input ?? {};
      const json = JSON.stringify(raw);
      const output = typeof input.tool_output === 'string' ? input.tool_output : JSON.stringify(input.tool_output ?? null);
      return { ...base, kind: 'tool', id: typeof input.tool_use_id === 'string' ? input.tool_use_id : null, name: String(input.tool_name ?? ''), input: json.length > CLIP ? { truncated: clip(json) } : raw, output: clip(output) };
    }
    default:
      return null;
  }
}

/**
 * Appends one redacted record for a recordable hook. Returns the record kind, or null when the
 * person is not connected, the grant has no sessions scope, the event is not recorded under
 * this scope, or the spool is at its size bound.
 */
export function record(input, { paths, now = Date.now() }) {
  const credentials = loadCredentials(paths);
  const scope = credentials ? sessionScopeOf(credentials.scopes) : null;
  const id = conversationIdOf(input);
  if (!scope || !id) return null;
  const rec = recordOf(input, scope, now);
  if (!rec) return null;
  const file = spoolFile(paths, id);
  if (existsSync(file) && statSync(file).size > SPOOL_MAX_BYTES) return null;
  const redacted = redactValue(rec);
  mkdirSync(paths.spool, { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify({ ...redacted.value, hits: redacted.hits })}\n`, { mode: 0o600 });
  return rec.kind;
}

/** Moves the spool aside and reads it, so records appended meanwhile start a fresh spool. */
export function takeSpool(paths, conversationId) {
  const file = spoolFile(paths, conversationId);
  if (!existsSync(file)) return [];
  const taken = `${file}.${process.pid}.taking`;
  renameSync(file, taken);
  try {
    return readFileSync(taken, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  } finally {
    unlinkSync(taken);
  }
}

/** Spools of conversations that never reached a stop are dropped after 7 days. */
export function pruneSpools(paths, now = Date.now()) {
  if (!existsSync(paths.spool)) return 0;
  let n = 0;
  for (const f of readdirSync(paths.spool)) {
    const p = join(paths.spool, f);
    if (now - statSync(p).mtimeMs > SPOOL_MAX_AGE_MS) {
      unlinkSync(p);
      n += 1;
    }
  }
  return n;
}

/** Spool records -> the classified entries buildSession() takes. */
export function spoolEntries(records, { conversationId = null, branch = null } = {}) {
  const out = [];
  for (const r of records) {
    const base = { at: r.at ?? null, cwd: r.cwd ?? null, sessionId: conversationId, branch, sidechain: false };
    if (r.kind === 'prompt') out.push({ ...base, kind: 'prompt', text: r.text, meta: false });
    else if (r.kind === 'file') out.push({ ...base, kind: 'file-change', path: r.path });
    else if (r.kind === 'assistant-text') out.push({ ...base, kind: 'assistant-text', text: r.text });
    else if (r.kind === 'tool') {
      out.push({ ...base, kind: 'tool-use', toolUseId: r.id, name: r.name, input: r.input });
      out.push({ ...base, kind: 'tool-result', toolUseId: r.id, text: r.output ?? '' });
    }
  }
  return out;
}

/**
 * stop / sessionEnd: the conversation's spool -> one report_session (or the queue).
 * offline: queue without the network (sessionEnd is fire-and-forget and may be cut short).
 */
export async function flushConversation({ conversationId, event = 'stop', offline = false, paths, fetchImpl = globalThis.fetch, now = Date.now }) {
  const summary = newSummary(event);
  const credentials = loadCredentials(paths);
  if (!credentials) {
    summary.skipped = 'not-connected';
    return summary;
  }
  const scope = sessionScopeOf(credentials.scopes);
  if (!scope) {
    summary.skipped = 'no-sessions-scope';
    return summary;
  }
  pruneSpools(paths, now());
  const delivery = createDelivery({ credentials, paths, fetchImpl, now, summary });
  const records = conversationId ? takeSpool(paths, conversationId) : [];
  if (records.some((r) => r.kind === 'prompt' || r.kind === 'assistant-text' || r.kind === 'tool')) {
    const cwd = records.find((r) => r.cwd)?.cwd ?? null;
    const entries = spoolEntries(records, { conversationId, branch: cwd ? gitBranch(cwd) : null });
    const cursorPath = paths.cursor(`cursor-${safeId(conversationId)}`);
    const seq = ((readJson(cursorPath)?.seq) ?? 0) + 1;
    writeJsonPrivate(cursorPath, { seq, lastFlushAt: new Date(now()).toISOString(), lastEvent: event });
    const session = buildSession(entries, { scope, sessionId: conversationId, transcriptId: conversationId, cwd, gitRemotes: cwd ? gitRemoteNames(cwd) : [], harness: 'cursor' });
    session.delta = { seq, event, records: records.length };
    await delivery.deliver(session, { offline, priorHits: mergeHits(...records.map((r) => r.hits)) });
  }
  if (summary.queued === 0 && !offline) await delivery.drainQueue();
  summary.queue = queueSize(paths.queue);
  return summary;
}

/**
 * The text for stop's `followup_message`, or null. Cursor SUBMITS a followup as the next user
 * message, so this is guarded hard: only after a turn that completed normally and was not itself
 * a followup (loop_count 0), only for a cached open question not put to the person in the last
 * 14 days, at most one per stop. The marker lets beforeSubmitPrompt recognise it.
 */
export function followupFor({ paths, status, loopCount, now = Date.now() }) {
  if (status !== 'completed' || loopCount !== 0) return null;
  const cached = readJson(paths.openQuestions);
  const questions = Array.isArray(cached?.open_questions) ? cached.open_questions.filter((q) => q && typeof q.text === 'string' && typeof q.id === 'string') : [];
  if (!questions.length) return null;
  const surfaced = readJson(paths.surfacedQuestions) ?? {};
  const q = questions.find((x) => !(typeof surfaced[x.id] === 'string' && now - Date.parse(surfaced[x.id]) < QUESTION_BACKOFF_MS));
  if (!q) return null;
  surfaced[q.id] = new Date(now).toISOString();
  writeJsonPrivate(paths.surfacedQuestions, surfaced);
  return `${FOLLOWUP_MARKER} The person's Wybe AI colleague has an open question for them. Ask it in one short sentence, in the person's language, and do nothing else this turn: "${q.text}". If they answer, pass the answer to the \`wybe\` MCP server's \`remember\` tool with \`answers: ["${q.id}"]\`. Work only; if they do not want to answer, drop it.`;
}
