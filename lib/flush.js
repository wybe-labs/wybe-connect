// One flush: the transcript delta since the last cursor -> scope-aware payload -> redaction ->
// report_session on the node (or the local queue), then a drain of the queue. Called by the
// Stop, SessionEnd and PreCompact hooks. Every failure is a value in the returned summary; the
// hook wrapper decides what to print. Nothing here prints.

import { basename } from 'node:path';
import { paths as defaultPaths, loadCredentials, saveCredentials, readJson, writeJsonPrivate } from './home.js';
import { parseTranscript, readDelta, buildSession, gitRemoteNames } from './transcript.js';
import { redactValue } from './redact.js';
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

export async function flush({ transcriptPath, sessionId = null, cwd = null, event = 'Stop', paths = defaultPaths(), fetchImpl = globalThis.fetch, now = Date.now }) {
  const summary = { event, skipped: null, built: false, sent: 0, queued: 0, drained: 0, hits: [], unknownTypes: {}, openQuestions: 0, queue: null };
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

  if (transcriptPath) {
    const transcriptId = transcriptIdOf(transcriptPath);
    const cursorPath = paths.cursor(transcriptId);
    const cursor = readJson(cursorPath) ?? { byteOffset: 0, seq: 0 };
    const delta = readDelta(transcriptPath, cursor.byteOffset);
    if (delta.text.length > 0) {
      const parsed = parseTranscript(delta.text);
      summary.unknownTypes = parsed.unknownTypes;
      const reportable = parsed.entries.some((e) => !e.sidechain && (e.kind === 'prompt' || e.kind === 'assistant-text' || e.kind === 'tool-use'));
      const seq = (cursor.seq ?? 0) + 1;
      writeJsonPrivate(cursorPath, { byteOffset: delta.nextOffset, seq, lastFlushAt: new Date(now()).toISOString(), lastEvent: event });
      if (reportable) {
        const session = buildSession(parsed.entries, { scope, sessionId, transcriptId, cwd, gitRemotes: cwd ? gitRemoteNames(cwd) : [] });
        session.delta = { seq, event, byte_from: delta.restarted ? 0 : cursor.byteOffset, byte_to: delta.nextOffset, restarted: delta.restarted };
        const redacted = redactValue(session);
        redacted.value.redaction = { families: redacted.hits };
        summary.built = true;
        summary.hits = redacted.hits;
        if (await send(redacted.value)) summary.sent += 1;
        else {
          enqueue(paths.queue, redacted.value, { now: now() });
          summary.queued += 1;
        }
      }
    }
  }

  if (summary.queued === 0) {
    const drained = await drain(paths.queue, send);
    summary.drained = drained.sent;
  }
  summary.queue = queueSize(paths.queue);
  return summary;
}
