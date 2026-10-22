// The plugin's own MCP server (stdio), so ONE sign-in serves both the hooks and the interactive
// tools. Before this, the hooks used the grant from bin/connect.js and the tools went through a
// second server added by hand (`claude mcp add`) with its own OAuth consent: two sign-ins, and a
// URL to copy. Now:
//   not connected  tools/list = [connect]; `connect(node_url)` starts the OAuth flow (lib/oauth.js)
//                  in the background and answers at once with the sign-in URL; when the browser
//                  flow completes, the grant is stored where the hooks read it and the server
//                  sends notifications/tools/list_changed
//   connected      tools/list = the node's own tools + connect; tools/call is forwarded to the
//                  node's /mcp with the stored bearer (one refresh on 401), the result verbatim
//   distil run     (`distilRun` set: the background `claude -p` of lib/distil.js) tools/list is fixed,
//                  whatever the node or the sign-in: remember, distil_done, pending_questions.
//                  remember is redacted and appended to the run's outbox, never forwarded; the
//                  watchdog delivers the outbox after distil_done. pending_questions is forwarded.
// Import: a node answer carrying import_request.requested_at is handed to `onImportRequest`
// (Claude Code wires it to the distil scheduler). pollImport() asks pending_questions for one.
// Write-only stays true: the proxy forwards only the node's own tools, and the node has no read tool.
// stdout carries JSON-RPC only; nothing here prints a token.

import { createInterface } from 'node:readline';
import { connect as defaultConnect, refreshTokens, ALL_SCOPES } from './oauth.js';
import { forward, openQuestionsOf, PROTOCOL_VERSION } from './post.js';
import { loadCredentials, saveCredentials, writeJsonPrivate } from './home.js';
import { spoolRemember, spoolDone } from './distil.js';
import { redactValue } from './redact.js';

export const SERVER_INFO = Object.freeze({ name: 'wybe', version: '0.2.0' });

export const CONNECT_TOOL = Object.freeze({
  name: 'connect',
  description: 'Connect this Claude Code to the person\'s Wybe AI colleague, once. Pass the colleague\'s address (https://<company>.wybe.me). A browser opens on the Wybe sign-in page; the person signs in with their passkey and ticks what to share. The answer carries the sign-in link in case no browser appeared. Call it again to see whether the sign-in has finished, or to reconnect.',
  inputSchema: {
    type: 'object',
    properties: {
      node_url: { type: 'string', description: 'The AI colleague\'s address, e.g. https://dittfirma.wybe.me' },
    },
    required: ['node_url'],
    additionalProperties: false,
  },
});

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export const DISTIL_TOOLS = Object.freeze([
  Object.freeze({
    name: 'remember',
    description: 'Queue durable facts about the person\'s WORK for their Wybe AI colleague: projects, decisions, preferences, ways of working, tools, ideas. One short, self-contained statement per item. Work only: nothing personal, nothing about other people, no secrets. The facts are sent after distil_done.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { content: { type: 'string', minLength: 1, maxLength: 4000 }, category: { type: 'string' }, subject: { type: 'string', maxLength: 200 } }, required: ['content'] } },
        answers: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'ids of open_questions this send answers' },
        import_of: { type: 'string', maxLength: 64, description: 'the import_of value from the instructions, on the last call of an import' },
      },
      required: ['items'],
    },
  }),
  Object.freeze({
    name: 'distil_done',
    description: 'Call exactly once, at the end of the distil run, also when nothing was worth sending. Without it nothing is sent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }),
  Object.freeze({
    name: 'pending_questions',
    description: 'The Wybe AI colleague\'s open questions about the person\'s work. Answer one with remember(…, answers: [id]) only where the material clearly does.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }),
]);

/** The node's remember shape, unknown keys dropped. Returns { args } or { error }. */
export function cleanRememberArgs(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : null;
  if (!items || items.length < 1 || items.length > 50) return { error: 'items must be a list of 1 to 50 facts' };
  const clean = [];
  for (const it of items) {
    if (typeof it?.content !== 'string' || it.content.trim() === '' || it.content.length > 4000) return { error: 'each item needs a content string of 1 to 4000 characters' };
    clean.push({ content: it.content, ...(typeof it.category === 'string' ? { category: it.category } : {}), ...(typeof it.subject === 'string' && it.subject.length <= 200 ? { subject: it.subject } : {}) });
  }
  const args = { items: clean };
  if (Array.isArray(raw.answers)) args.answers = raw.answers.filter((a) => typeof a === 'string').slice(0, 10);
  if (typeof raw.import_of === 'string' && raw.import_of.length <= 64) args.import_of = raw.import_of;
  return { args };
}

/** import_request.requested_at in a node answer, or null. */
export function importRequestOf(result) {
  const fromStructured = result?.structuredContent?.import_request?.requested_at;
  if (typeof fromStructured === 'string') return fromStructured;
  const t = Array.isArray(result?.content) ? result.content.find((c) => c?.type === 'text')?.text : undefined;
  try {
    const at = typeof t === 'string' ? JSON.parse(t)?.import_request?.requested_at : undefined;
    return typeof at === 'string' ? at : null;
  } catch {
    return null;
  }
}

/**
 * handle(message) answers one JSON-RPC message (null for a notification); notify(message) is how
 * the proxy pushes notifications/tools/list_changed after a sign-in completes.
 */
export function createProxy({ paths, clientName = 'wybe-connect (Claude Code)', notify = () => {}, fetchImpl = globalThis.fetch, connectImpl = defaultConnect, now = Date.now, distilRun = null, onImportRequest = null }) {
  let pending = null; // { nodeUrl, url, done, error }

  const credentials = () => {
    try {
      return loadCredentials(paths);
    } catch {
      return null;
    }
  };

  async function upstream(method, params) {
    let c = credentials();
    if (!c) return { ok: false, kind: 'not-connected', message: 'not connected' };
    let out = await forward({ endpoint: c.mcpEndpoint, accessToken: c.accessToken, method, params, fetchImpl });
    if (!out.ok && out.kind === 'auth' && c.refreshToken) {
      const next = await refreshTokens({ tokenEndpoint: c.tokenEndpoint, clientId: c.clientId, refreshToken: c.refreshToken, resource: c.resource ?? c.mcpEndpoint, requestedScopes: c.scopes, fetchImpl, now: now() });
      if (next) {
        c = { ...c, ...next };
        saveCredentials(c, paths);
        out = await forward({ endpoint: c.mcpEndpoint, accessToken: c.accessToken, method, params, fetchImpl });
      }
    }
    return out;
  }

  function startConnect(nodeUrl) {
    let resolveUrl;
    const urlKnown = new Promise((r) => { resolveUrl = r; });
    const state = { nodeUrl, url: null, done: false, error: null };
    pending = state;
    connectImpl(nodeUrl, {
      scopes: ALL_SCOPES,
      clientName,
      fetchImpl,
      onUrl: (url) => { state.url = url; resolveUrl(); },
      log: () => {},
    }).then((creds) => {
      saveCredentials(creds, paths);
      state.done = true;
      notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }).catch((err) => {
      state.error = err instanceof Error ? err.message : String(err);
    }).finally(() => resolveUrl());
    return urlKnown.then(() => state);
  }

  async function callConnect(args) {
    const raw = typeof args?.node_url === 'string' ? args.node_url.trim() : '';
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch {
      return text('Give the AI colleague\'s address, e.g. https://dittfirma.wybe.me', true);
    }
    if (pending && !pending.done && !pending.error && pending.nodeUrl === origin) {
      return text(`Still waiting for the sign-in in the browser. If no browser opened, open this link: ${pending.url}`);
    }
    if (pending?.done && pending.nodeUrl === origin) {
      pending = null;
      const c = credentials();
      return text(`Connected to ${c?.nodeUrl ?? origin} (scopes: ${(c?.scopes ?? []).join(', ')}). The Wybe tools are available now.`);
    }
    if (pending?.error && pending.nodeUrl === origin) {
      const why = pending.error;
      pending = null;
      return text(`The last sign-in did not finish (${why}). Call connect again to retry.`, true);
    }
    const state = await startConnect(origin);
    if (state.error) return text(`Could not start the sign-in: ${state.error}`, true);
    if (state.done) {
      const c = credentials();
      return text(`Connected to ${c?.nodeUrl ?? origin} (scopes: ${(c?.scopes ?? []).join(', ')}). The Wybe tools are available now.`);
    }
    return text(`A browser window is opening on the Wybe sign-in page. Ask the person to sign in with their passkey and tick what they want to share, then call connect again to confirm. If no browser opened, they can open this link: ${state.url}`);
  }

  const seeImport = (result) => {
    const at = onImportRequest ? importRequestOf(result) : null;
    if (at) {
      try {
        onImportRequest(at);
      } catch {
        // the scheduler is best effort here; the next answer carries the request again
      }
    }
  };

  /** One pending_questions call, only to learn about an import request. Returns the requested_at seen, or null. */
  async function pollImport() {
    const c = credentials();
    if (!onImportRequest || !c || !c.scopes.includes('remember')) return null;
    const out = await upstream('tools/call', { name: 'pending_questions', arguments: {} });
    if (!out.ok) return null;
    seeImport(out.result);
    return importRequestOf(out.result);
  }

  async function handleDistil(method, params, reply, fail) {
    switch (method) {
      case 'tools/list':
        return reply({ tools: DISTIL_TOOLS });
      case 'tools/call': {
        const name = params?.name;
        if (name === 'remember') {
          const cleaned = cleanRememberArgs(params?.arguments);
          if (cleaned.error) return reply(text(cleaned.error, true));
          const r = spoolRemember(paths, distilRun, cleaned.args);
          if (r.error) return reply(text(r.error, true));
          return reply(text(`Queued ${cleaned.args.items.length} item(s) as call ${r.seq}. They are sent to the colleague after distil_done.`));
        }
        if (name === 'distil_done') {
          const r = spoolDone(paths, distilRun);
          return reply(text(`Done: ${r.items} remember call(s) will be sent to the colleague.`));
        }
        if (name === 'pending_questions') {
          if (!credentials()) return reply(text('{"ok":true,"open_questions":[]}'));
          const out = await upstream('tools/call', { name, arguments: {} });
          return reply(out.ok ? out.result : text('{"ok":true,"open_questions":[]}'));
        }
        return reply(text(`No tool ${String(name)} in a distil run.`, true));
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null;
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (!isRequest) return null; // notifications (initialized, cancelled) need no answer

    if (distilRun && method !== 'initialize' && method !== 'ping') return handleDistil(method, params, reply, fail);
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: SERVER_INFO,
        });
      case 'ping':
        return reply({});
      case 'tools/list': {
        if (!credentials()) return reply({ tools: [CONNECT_TOOL] });
        const out = await upstream('tools/list', {});
        const tools = out.ok && Array.isArray(out.result?.tools) ? out.result.tools.filter((t) => t?.name !== CONNECT_TOOL.name) : [];
        return reply({ tools: [...tools, CONNECT_TOOL] });
      }
      case 'tools/call': {
        const name = params?.name;
        if (name === CONNECT_TOOL.name) return reply(await callConnect(params?.arguments));
        if (!credentials()) return reply(text('Not connected to a Wybe AI colleague yet. Call `connect` with the colleague\'s address first.', true));
        // Every argument passes through redactValue before it leaves the machine (QA R5-1); one the
        // walker cannot read is refused rather than forwarded.
        let args;
        try {
          args = redactValue(params?.arguments ?? {}).value;
        } catch {
          return reply(text('Not delivered: the arguments could not be checked for secrets, so nothing was sent.', true));
        }
        const out = await upstream('tools/call', { name, arguments: args });
        if (!out.ok) {
          const why = out.kind === 'auth' ? 'the connection was refused (revoked or expired); call `connect` again' : `the AI colleague could not be reached (${out.kind}: ${out.message})`;
          return reply(text(`Not delivered: ${why}.`, true));
        }
        const questions = openQuestionsOf(out.result);
        if (questions.length) writeJsonPrivate(paths.openQuestions, { fetched_at: new Date(now()).toISOString(), open_questions: questions });
        seeImport(out.result);
        return reply(out.result);
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  }

  return { handle, pollImport };
}

export const POLL_FIRST_MS = 2000;
export const POLL_EVERY_MS = 5 * 60 * 1000;

/**
 * Newline-delimited JSON-RPC on stdin/stdout (the MCP stdio transport). With onImportRequest, an
 * «Importer» press is picked up while Claude Code is open: pending_questions 2 s after start, then
 * every 5 minutes (timers unref'd, so they never keep the process alive).
 */
export function runStdio({ paths, clientName, input = process.stdin, output = process.stdout, distilRun = null, onImportRequest = null }) {
  const write = (m) => output.write(`${JSON.stringify(m)}\n`);
  const proxy = createProxy({ paths, clientName, notify: write, distilRun, onImportRequest });
  if (onImportRequest && !distilRun) {
    const tick = () => { proxy.pollImport().catch(() => {}); };
    setTimeout(tick, POLL_FIRST_MS).unref?.();
    setInterval(tick, POLL_EVERY_MS).unref?.();
  }
  const rl = createInterface({ input });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    try {
      const answer = await proxy.handle(msg);
      if (answer) write(answer);
    } catch (err) {
      if (msg?.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message.split('\n')[0] : 'internal error' } });
    }
  });
  return rl;
}
