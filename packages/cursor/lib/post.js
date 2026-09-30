// Delivers a tool call to the node's MCP endpoint over Streamable HTTP, as a plain JSON-RPC 2.0
// client: initialize -> notifications/initialized -> tools/call, carrying the Mcp-Session-Id the
// server hands out and the OAuth access token as a Bearer. Accepts a JSON body or an SSE stream
// (the first JSON-RPC message with our id wins). This module never logs anything: the token is
// in the headers and nothing here prints headers.
//
// Outcomes are values, not exceptions:
//   { ok: true,  result, openQuestions }
//   { ok: false, kind: 'auth' | 'network' | 'server' | 'protocol', status?, message }

export const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'wybe-connect', version: '0.1.0' };
const DEFAULT_TIMEOUT_MS = 15_000;

let nextId = 1;

function headersFor(accessToken, sessionId) {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${accessToken}`,
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

async function rpc({ endpoint, accessToken, sessionId, fetchImpl, timeoutMs, method, params, notification = false }) {
  const id = notification ? undefined : nextId++;
  const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: headersFor(accessToken, sessionId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, kind: 'network', message: describeNetworkError(err) };
  }
  const newSession = res.headers.get('mcp-session-id') ?? sessionId ?? null;
  if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth', status: res.status, message: `HTTP ${res.status}` };
  if (notification) {
    return res.ok || res.status === 202 ? { ok: true, sessionId: newSession } : { ok: false, kind: 'server', status: res.status, message: `HTTP ${res.status}` };
  }
  if (!res.ok) return { ok: false, kind: 'server', status: res.status, message: `HTTP ${res.status}` };
  let message;
  try {
    message = await firstMessage(res, id);
  } catch (err) {
    return { ok: false, kind: 'protocol', status: res.status, message: err.message };
  }
  if (!message) return { ok: false, kind: 'protocol', status: res.status, message: 'no JSON-RPC response with our id' };
  if (message.error) return { ok: false, kind: 'server', status: res.status, message: `JSON-RPC error ${message.error.code ?? '?'}: ${String(message.error.message ?? '').slice(0, 200)}` };
  return { ok: true, result: message.result, sessionId: newSession };
}

function describeNetworkError(err) {
  const code = err?.cause?.code ?? err?.code ?? err?.name ?? 'unknown';
  return `network: ${code}`;
}

async function firstMessage(res, id) {
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const text = await res.text();
  if (type.includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      const parsed = JSON.parse(data);
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
        if (m && m.id === id) return m;
      }
    }
    return null;
  }
  if (text.trim() === '') return null;
  const parsed = JSON.parse(text);
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    if (m && m.id === id) return m;
  }
  return null;
}

/**
 * One tool call through a fresh MCP session. Returns the outcome shapes documented above.
 */
export async function callTool({ endpoint, accessToken, name, args, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof accessToken !== 'string' || accessToken.length === 0) return { ok: false, kind: 'auth', message: 'no access token' };
  const common = { endpoint, accessToken, fetchImpl, timeoutMs };
  const init = await rpc({
    ...common,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  });
  if (!init.ok) return init;
  const sessionId = init.sessionId;
  const ack = await rpc({ ...common, sessionId, method: 'notifications/initialized', params: {}, notification: true });
  if (!ack.ok) return ack;
  const call = await rpc({ ...common, sessionId, method: 'tools/call', params: { name, arguments: args } });
  if (sessionId) {
    try {
      await fetchImpl(endpoint, { method: 'DELETE', headers: headersFor(accessToken, sessionId), signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      // closing the server-side session is a courtesy
    }
  }
  if (!call.ok) return call;
  const result = call.result ?? {};
  if (result.isError === true) {
    const text = Array.isArray(result.content) ? result.content.map((c) => c?.text ?? '').join(' ') : '';
    return { ok: false, kind: 'server', message: `tool error: ${text.slice(0, 200)}` };
  }
  return { ok: true, result, openQuestions: openQuestionsOf(result) };
}

export function openQuestionsOf(result) {
  const fromStructured = result?.structuredContent?.open_questions;
  if (Array.isArray(fromStructured)) return fromStructured;
  const text = Array.isArray(result?.content) ? result.content.find((c) => c?.type === 'text')?.text : undefined;
  if (typeof text === 'string') {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.open_questions)) return parsed.open_questions;
    } catch {
      // the text was prose, not JSON: no questions carried
    }
  }
  return [];
}

/**
 * report_session with one refresh attempt on an auth refusal. `refresh(credentials)` returns new
 * credentials or null. The caller queues on any { ok: false }.
 * Returns { outcome, credentials } where credentials are the (possibly refreshed) ones to store.
 */
export async function reportSession({ credentials, session, fetchImpl = globalThis.fetch, refresh = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const attempt = (creds) => {
    const { mcpEndpoint: endpoint, accessToken } = creds;
    return callTool({ endpoint, accessToken, name: 'report_session', args: { session }, fetchImpl, timeoutMs });
  };
  let outcome = await attempt(credentials);
  if (outcome.ok || outcome.kind !== 'auth' || !refresh) return { outcome, credentials };
  const fresh = await refresh(credentials);
  if (!fresh) return { outcome, credentials };
  outcome = await attempt(fresh);
  return { outcome, credentials: fresh };
}
