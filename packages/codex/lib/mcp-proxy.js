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
// Write-only stays true: the proxy forwards only the node's own tools, and the node has no read tool.
// Every forwarded argument is redacted first (lib/redact.js; the ruling's laptop-side redaction).
// Import: when a node answer carries `import_request` (the person pressed «Importer» in the portal),
// the proxy hands it to lib/distil.js, which starts the background distil run. While Claude Code is
// open the proxy also asks `pending_questions` at start and every POLL_MINUTES, so a press reaches a
// running Claude Code without waiting for the next tool call. Inside a distil run it does neither.
// stdout carries JSON-RPC only; nothing here prints a token.

import { createInterface } from 'node:readline';
import { connect as defaultConnect, refreshTokens } from './oauth.js';
import { forward, openQuestionsOf, PROTOCOL_VERSION } from './post.js';
import { loadCredentials, saveCredentials, writeJsonPrivate } from './home.js';
import { redactValue } from './redact.js';
import { importRequestOf, inDistilRun, maybeRun } from './distil.js';

export const POLL_MINUTES = 5;
/**
 * What the one sign-in asks for (QA F7): essence only means `remember` (facts, answers, import_of)
 * is all Claude Code sends. `pending_questions` needs no scope. The sessions:* and conversations
 * scopes are left off the consent screen rather than asked for and never used.
 */
export const CONNECT_SCOPES = Object.freeze(['remember']);

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

/**
 * handle(message) answers one JSON-RPC message (null for a notification); notify(message) is how
 * the proxy pushes notifications/tools/list_changed after a sign-in completes.
 */
export function createProxy({ paths, clientName = 'wybe-connect (Claude Code)', notify = () => {}, fetchImpl = globalThis.fetch, connectImpl = defaultConnect, now = Date.now, onImportRequest = () => {} }) {
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
      scopes: [...CONNECT_SCOPES],
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

  /** Caches open questions and hands an import request on, for any node answer. */
  function noticeAnswer(result) {
    const questions = openQuestionsOf(result);
    if (questions.length) writeJsonPrivate(paths.openQuestions, { fetched_at: new Date(now()).toISOString(), open_questions: questions });
    const requestedAt = importRequestOf(result);
    if (requestedAt) onImportRequest(requestedAt);
  }

  /** One `pending_questions` call: the read the ruling allows, and how an «Importer» press arrives. */
  async function poll() {
    if (!credentials()) return null;
    const out = await upstream('tools/call', { name: 'pending_questions', arguments: {} });
    if (out.ok) noticeAnswer(out.result);
    return out;
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null;
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (!isRequest) return null; // notifications (initialized, cancelled) need no answer

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
        const out = await upstream('tools/call', { name, arguments: redactValue(params?.arguments ?? {}).value });
        if (!out.ok) {
          const why = out.kind === 'auth' ? 'the connection was refused (revoked or expired); call `connect` again' : `the AI colleague could not be reached (${out.kind}: ${out.message})`;
          return reply(text(`Not delivered: ${why}.`, true));
        }
        noticeAnswer(out.result);
        return reply(out.result);
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  }

  return { handle, poll };
}

/** Newline-delimited JSON-RPC on stdin/stdout (the MCP stdio transport). */
export function runStdio({ paths, clientName, input = process.stdin, output = process.stdout, env = process.env }) {
  const write = (m) => output.write(`${JSON.stringify(m)}\n`);
  const distilling = inDistilRun(env);
  const onImportRequest = (requestedAt) => {
    if (!distilling) maybeRun({ paths, importRequestedAt: requestedAt, env });
  };
  const proxy = createProxy({ paths, clientName, notify: write, onImportRequest });
  if (!distilling) {
    const tick = () => proxy.poll().catch(() => {});
    setTimeout(tick, 2_000).unref();
    setInterval(tick, POLL_MINUTES * 60_000).unref();
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
