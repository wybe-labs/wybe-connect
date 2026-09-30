// One flush: the transcript delta since the last cursor -> scope-aware payload -> redaction ->
// report_session on the node (or the local queue), then a drain of the queue. Called by the
// Claude Code (Stop, SessionEnd, PreCompact) and Codex (Stop, PreCompact, SessionEnd) hooks; the
// Cursor adapter builds its session from a spool and uses createDelivery() directly. Every
// failure is a value in the returned summary; the hook wrapper decides what to print. Nothing
// here prints.

import { basename } from 'node:path';
import { paths as defaultPaths, loadCredentials, saveCredentials, readJson, writeJsonPrivate } from './home.js';
import { parseTranscript, readDelta, buildSession, gitRemoteNames } from './transcript.js';
import { parseRollout, rolloutHead } from './codex-rollout.js';
import { redactValue, FAMILIES } from './redact.js';
import { reportSession } from './post.js';
import { refreshTokens } from './oauth.js';
import { enqueue, drain, size as queueSize } from './queue.js';

/** The sessions scope the grant allows: full beats light; none means report_session never fires. */
export function sessionScopeOf(scopes) {
  if (scopes.includes('sessions:full')) return 'sessions:full';
  if (scopes.includes('sessions:light')) return 'sessions:light';
  return null;
}

export function transcriptIdOf(transcriptPath) {
  return basename(transcriptPath).replace(/\.jsonl$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Sums per-family hit counts from several redaction passes, in FAMILIES order. */
export function mergeHits(...lists) {
  const totals = new Map();
  for (const list of lists) for (const h of list ?? []) totals.set(h.family, (totals.get(h.family) ?? 0) + h.count);
  return FAMILIES.filter((f) => totals.has(f.name)).map((f) => ({ family: f.name, count: totals.get(f.name) }));
}

export function newSummary(event) {
  return { event, skipped: null, built: false, sent: 0, queued: 0, drained: 0, hits: [], unknownTypes: {}, openQuestions: 0, queue: null };
}

/**
 * Sending for one flush. Holds the (possibly refreshed) credentials, stores a refresh, caches the
 * open questions a tool answer carries, and queues what the node did not take.
 *   deliver(session, { offline, priorHits })  redact -> send (unless offline) -> else enqueue
 *   drainQueue()                               oldest first, stops at the first refusal
 * `priorHits` are the counts of an earlier redaction pass over the same content (Cursor's
 * spool); the payload's `redaction.families` reports both passes together. Redaction is
 * idempotent (test/redact.test.js), so the second pass adds no hits for what the first caught.
 */
export function createDelivery({ credentials, paths, fetchImpl = globalThis.fetch, now = Date.now, summary }) {
  let creds = credentials;
  const refresh = async (c) => {
    const next = await refreshTokens({ tokenEndpoint: c.tokenEndpoint, clientId: c.clientId, refreshToken: c.refreshToken, resource: c.nodeUrl, requestedScopes: c.scopes, fetchImpl, now: now() });
    if (!next) return null;
    return { ...c, ...next };
  };
  const send = async (session) => {
    const { outcome, credentials: after } = await reportSession({ credentials: creds, session, fetchImpl, refresh });
    if (after !== creds) {
      creds = after;
      saveCredentials(creds, paths);
    }
    if (outcome.ok) {
      if (outcome.openQuestions.length) {
        writeJsonPrivate(paths.openQuestions, { fetched_at: new Date(now()).toISOString(), open_questions: outcome.openQuestions });
        summary.openQuestions = outcome.openQuestions.length;
      }
      return true;
    }
    summary.lastOutcome = { kind: outcome.kind, message: outcome.message };
    return false;
  };
  const deliver = async (session, { offline = false, priorHits = [] } = {}) => {
    const redacted = redactValue(session);
    const hits = mergeHits(priorHits, redacted.hits);
    redacted.value.redaction = { families: hits };
    summary.built = true;
    summary.hits = hits;
    if (!offline && await send(redacted.value)) {
      summary.sent += 1;
      return;
    }
    if (offline) summary.lastOutcome = { kind: 'offline', message: 'queued without a network attempt' };
    enqueue(paths.queue, redacted.value, { now: now() });
    summary.queued += 1;
  };
  const drainQueue = async () => {
    const drained = await drain(paths.queue, send);
    summary.drained += drained.sent;
  };
  return { deliver, drainQueue };
}

/**
 * harness: 'claude-code' (transcript JSONL) | 'codex' (rollout JSONL, lib/codex-rollout.js).
 * offline: build and queue without touching the network, and do not drain. Codex's SessionEnd
 * runs under a hard 3 s cap (codex-rs/hooks/src/events/session_end.rs), too short to be sure a
 * request finishes before the process is killed; the next flush sends what it queued.
 */
export async function flush({ transcriptPath, sessionId = null, cwd = null, event = 'Stop', harness = 'claude-code', offline = false, paths = defaultPaths(), fetchImpl = globalThis.fetch, now = Date.now }) {
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
  const delivery = createDelivery({ credentials, paths, fetchImpl, now, summary });

  if (transcriptPath) {
    let parse = (text) => parseTranscript(text);
    if (harness === 'codex') {
      if (transcriptPath.endsWith('.zst')) {
        summary.skipped = 'compressed-rollout';
        return summary;
      }
      const head = rolloutHead(transcriptPath);
      if (!head || !head.personThread) {
        summary.skipped = 'not-a-person-thread';
        return summary;
      }
      cwd = cwd ?? head.cwd;
      parse = (text) => parseRollout(text, { head });
    }
    const transcriptId = transcriptIdOf(transcriptPath);
    const cursorPath = paths.cursor(transcriptId);
    const cursor = readJson(cursorPath) ?? { byteOffset: 0, seq: 0 };
    const delta = readDelta(transcriptPath, cursor.byteOffset);
    if (delta.text.length > 0) {
      const parsed = parse(delta.text);
      summary.unknownTypes = parsed.unknownTypes;
      const reportable = parsed.entries.some((e) => !e.sidechain && (e.kind === 'prompt' || e.kind === 'assistant-text' || e.kind === 'tool-use'));
      const seq = (cursor.seq ?? 0) + 1;
      writeJsonPrivate(cursorPath, { byteOffset: delta.nextOffset, seq, lastFlushAt: new Date(now()).toISOString(), lastEvent: event });
      if (reportable) {
        const session = buildSession(parsed.entries, { scope, sessionId, transcriptId, cwd, gitRemotes: cwd ? gitRemoteNames(cwd) : [], harness });
        session.delta = { seq, event, byte_from: delta.restarted ? 0 : cursor.byteOffset, byte_to: delta.nextOffset, restarted: delta.restarted };
        await delivery.deliver(session, { offline });
      }
    }
  }

  if (summary.queued === 0 && !offline) await delivery.drainQueue();
  summary.queue = queueSize(paths.queue);
  return summary;
}
