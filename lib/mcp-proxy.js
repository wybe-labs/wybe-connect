// The plugin's own MCP server (stdio), so ONE sign-in serves both the hooks and the interactive
// tools. Before this, the hooks used the grant from bin/connect.js and the tools went through a
// second server added by hand (`claude mcp add`) with its own OAuth consent: two sign-ins, and a
// URL to copy. Now:
//   not connected  tools/list = [connect]; `connect(node_url)` starts the OAuth flow (lib/oauth.js)
//                  in the background and answers at once with the sign-in URL; when the browser
//                  flow completes, the grant is stored as a connection (lib/connections.js
//                  saveConnection: its own grantId, the new default), where the hooks read it,
//                  and the server sends notifications/tools/list_changed
//   connected      tools/list = the node's own tools + connect; tools/call is forwarded to the
//                  node's /mcp with the stored bearer (one refresh on 401), the result verbatim
//   distil run     (`distilRun` set: the background `claude -p` of lib/distil.js) tools/list is fixed,
//                  whatever the node or the sign-in: remember, distil_done, pending_questions.
//                  remember is redacted and appended to the run's outbox, never forwarded; the
//                  watchdog delivers the outbox after distil_done. pending_questions is forwarded.
//                  An item with the session_id of a session the run reads is that session's short
//                  summary: kept on this machine (lib/session-scan.js saveSummary) for sessions_report,
//                  never queued as a fact.
// Import: a node answer carrying import_request.requested_at is handed to `onImportRequest`
// (Claude Code and Codex wire it to the distil scheduler). pollImport() asks pending_questions for
// one: at start, every 5 minutes, and as soon as a sign-in from `connect` is stored.
// Write-only stays true: the proxy forwards only the node's own tools, and the node has no read tool.
// stdout carries JSON-RPC only; nothing here prints a token.

import { createInterface } from 'node:readline';
import { connect as defaultConnect, refreshTokens, harnessOf, ALL_SCOPES } from './oauth.js';
import { forward, openQuestionsOf, PROTOCOL_VERSION } from './post.js';
import { loadCredentials, saveCredentials, readJson, writeJsonPrivate } from './home.js';
import { connectionPaths, connectionNames, checkSave, saveConnection, sessionConnection, pinnedConnection, sessionIdRequired } from './connections.js';
import { spoolRemember, spoolDone, distilPaths } from './distil.js';
import { redactValue } from './redact.js';
import { renewStored } from './connect-cli.js';
import { accountOf } from './session-info.js';
import { findTask, decideTask } from './bridge.js';
import { saveSummary } from './session-scan.js';

export const SERVER_INFO = Object.freeze({ name: 'wybe', version: '0.2.0' });

/**
 * A node tool as offered here: with a session_id, which routes the call and never leaves the machine. Required
 * while a call could be another session's (lib/connections.js sessionIdRequired), optional otherwise.
 */
const withSessionId = (tool, required) => {
  const schema = tool?.inputSchema;
  if (!schema || schema.type !== 'object') return tool;
  const session = { type: 'string', description: 'This session\'s id, as the SessionStart note gives it. Required while the person has two or more connections, or a session sends elsewhere.' };
  const withId = { ...schema, properties: { ...(schema.properties ?? {}), session_id: session } };
  if (required) withId.required = [...new Set([...(Array.isArray(schema.required) ? schema.required : []), 'session_id'])];
  return { ...tool, inputSchema: withId };
};

export const NO_SESSION = 'Not delivered: pass session_id from the SessionStart note.';

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

// A task from the person's Wybe colleague that needs the person's yes (mode confirm, lib/bridge.js).
// The session's notice carries only the id; this tool is the one way to the text. With the
// client's elicitation capability the person decides in a form; without it the model is told to
// show the text word for word and act only after an explicit yes (model-mediated, a stated limit).
export const TAKE_TASK_TOOL = Object.freeze({
  name: 'take_task',
  description: 'Take a task the person\'s Wybe AI colleague sent to this session; the notice you got names its task_id. It shows the exact task to the person, who accepts or declines it, and returns the task only when they accept. If it says this client cannot show a form: show the task to the person word for word, ask them, and only after their explicit yes call take_task again with accepted: true (accepted: false when they say no).',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'the task id from the notice' },
      accepted: { type: 'boolean', description: 'only when this client shows no form: the person\'s own answer in the chat' },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
});

export const ELICIT_TIMEOUT_MS = 10 * 60 * 1000;
const quoted = (t) => `«${t}»`;
const accepted = (t) => text(`The person accepted the task. Do it now in this session: ${quoted(t)}. When you finish, end with a short summary of what you did; it is sent back to the colleague.`);
const declined = () => text('The person declined the task. Do not do it; the colleague has been told.');

// The node's remember schema refuses the WHOLE call on one argument it does not take (a category
// outside its list, an empty subject, an answer that is not a question id), and a refused record is
// never sent again: so the run is offered exactly that schema, and what it sends is made to fit it.
export const NODE_CATEGORIES = Object.freeze(['fact', 'preference', 'pattern', 'entity', 'insight', 'relation']);
// A question id as the node's z.uuid() (zod 4) takes it: version 1-8, variant 8/9/a/b, or the nil or max id.
const QUESTION_ID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

export const DISTIL_TOOLS = Object.freeze([
  Object.freeze({
    name: 'remember',
    description: 'Queue durable facts about the person\'s WORK for their Wybe AI colleague: projects, decisions, preferences, ways of working, tools, ideas. One short, self-contained statement per item. Work only: nothing personal, nothing about other people, no secrets. The facts are sent after distil_done.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { content: { type: 'string', minLength: 1, maxLength: 4000 }, category: { type: 'string', enum: [...NODE_CATEGORIES] }, subject: { type: 'string', minLength: 1, maxLength: 200 }, session_id: { type: 'string', maxLength: 200, description: 'only on a session summary: the session id from the instructions. The item stays on this machine as the summary of that session and is never sent as a fact.' } }, required: ['content'] } },
        answers: { type: 'array', maxItems: 10, items: { type: 'string', format: 'uuid', pattern: QUESTION_ID.source }, description: 'ids of open_questions this send answers' },
        import_of: { type: 'string', minLength: 1, maxLength: 64, description: 'the import_of value from the instructions, on the last call of an import' },
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

/**
 * The node's remember shape, unknown keys dropped. An optional field the node would refuse (a
 * category outside its list, an empty or too long subject, an answer that is not a question id, an
 * empty import_of) is left out, so the facts still go. Returns { args, summaries } or { error }. An item
 * with a `session_id` is a session summary ({ sessionId, content } in `summaries`), never one of the
 * node's items; `args` is null when every item was one.
 */
export function cleanRememberArgs(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : null;
  if (!items || items.length < 1 || items.length > 50) return { error: 'items must be a list of 1 to 50 facts' };
  const clean = [];
  const summaries = [];
  for (const it of items) {
    if (typeof it?.content !== 'string' || it.content.trim() === '' || it.content.length > 4000) return { error: 'each item needs a content string of 1 to 4000 characters' };
    if (it.session_id !== undefined) {
      if (typeof it.session_id !== 'string' || !it.session_id || it.session_id.length > 200) return { error: 'session_id must be a session id from the instructions' };
      summaries.push({ sessionId: it.session_id, content: it.content });
      continue;
    }
    clean.push({ content: it.content, ...(NODE_CATEGORIES.includes(it.category) ? { category: it.category } : {}), ...(typeof it.subject === 'string' && it.subject.length >= 1 && it.subject.length <= 200 ? { subject: it.subject } : {}) });
  }
  if (!clean.length) {
    if (typeof raw.import_of === 'string') return { error: 'pass import_of on a call that carries facts, not only session summaries' };
    return { args: null, summaries };
  }
  const args = { items: clean };
  if (Array.isArray(raw.answers)) {
    const answers = raw.answers.filter((a) => typeof a === 'string' && QUESTION_ID.test(a)).slice(0, 10);
    if (answers.length) args.answers = answers;
  }
  if (typeof raw.import_of === 'string' && raw.import_of.length >= 1 && raw.import_of.length <= 64) args.import_of = raw.import_of;
  return { args, summaries };
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
 * the proxy pushes notifications/tools/list_changed after a sign-in completes. `harnessAccount()`
 * is the account the harness is signed in to (by default read for the harness the fixed client
 * stands for): `connect` sends it as the sign-in's account hint and keeps a second account's grant
 * apart from the first (lib/connections.js accountKey). No answer of this server names it.
 */
export function createProxy({ paths: fixed = null, root = null, env = process.env, clientId = null, clientName = 'wybe-connect (Claude Code)', harnessAccount = () => accountOf(harnessOf(clientId), env), notify = () => {}, request = null, fetchImpl = globalThis.fetch, connectImpl = defaultConnect, now = Date.now, distilRun = null, onImportRequest = null }) {
  let pending = null; // { nodeUrl, url, done, error }
  const shown = new Set(); // ids of tasks whose text this server has returned to the session
  let canElicit = false; // the client declared the elicitation capability at initialize
  // With `root` (a harness home), a call that names no session takes the hooks' rule without the session step, at
  // that call: WYBE_CONNECT_NODE (unknown means none, never another), else the default (a `connect` from here, or a
  // renewal, makes that connection the default). It keeps no connection of its own, so one removed meanwhile is never used.
  // A call that names its session (session_id) resolves that session's connection at the call,
  // so `connect use <name> --session <id>` moves this server's calls along with the hooks.
  // The server remembers no session: its process outlives /clear, so it never stands for one. With
  // two or more connections, or a session pinned elsewhere, every call names its session; one that does not is refused.
  // It never writes a pin either (it knows no transcript): an id no hook has fixed goes where a new session goes.
  // With `paths`, it uses those as they are (a distil run's own connection, or the single layout).
  const idRequired = () => !!root && !fixed && sessionIdRequired(root);
  const current = (sessionId = null) => {
    if (fixed) return fixed;
    if (!root) return null;
    const k = sessionConnection(root, { sessionId, env });
    return k ? connectionPaths(root, k) : null;
  };

  const credentials = (sessionId = null) => {
    try {
      const p = current(sessionId);
      return p ? loadCredentials(p) : null;
    } catch {
      return null;
    }
  };

  async function upstream(method, params, sessionId = null) {
    let c = credentials(sessionId);
    if (!c) return { ok: false, kind: 'not-connected', message: 'not connected' };
    let out = await forward({ endpoint: c.mcpEndpoint, accessToken: c.accessToken, method, params, fetchImpl });
    if (!out.ok && out.kind === 'auth' && c.refreshToken) {
      const next = await refreshTokens({ tokenEndpoint: c.tokenEndpoint, clientId: c.clientId, refreshToken: c.refreshToken, resource: c.resource ?? c.mcpEndpoint, requestedScopes: c.scopes, fetchImpl, now: now() });
      if (next) {
        c = { ...c, ...next };
        // Stored only while the file still holds the grant this call started with: a grant removed
        // or replaced meanwhile (a new grantId, lib/connections.js) is never written over.
        const p = current(sessionId);
        let onDisk = null;
        try {
          onDisk = p ? readJson(p.credentials) : null;
        } catch {
          onDisk = null;
        }
        if (onDisk && (onDisk.grantId ?? null) === (c.grantId ?? null)) saveCredentials(c, p);
        out = await forward({ endpoint: c.mcpEndpoint, accessToken: c.accessToken, method, params, fetchImpl });
      }
    }
    return out;
  }

  /** Stores a finished sign-in: as a connection of its own (the new default), or in the fixed paths. */
  function store(creds) {
    if (fixed) {
      saveCredentials(creds, fixed);
      return;
    }
    saveConnection(root, creds);
  }

  function startConnect(nodeUrl) {
    let resolveUrl;
    const urlKnown = new Promise((r) => { resolveUrl = r; });
    const state = { nodeUrl, url: null, done: false, error: null };
    pending = state;
    connectImpl(nodeUrl, {
      scopes: ALL_SCOPES,
      clientId,
      clientName,
      harnessAccount: harnessAccount(),
      fetchImpl,
      onUrl: (url) => { state.url = url; resolveUrl(); },
      log: () => {},
    }).then((creds) => {
      store(creds);
      state.done = true;
      notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      // A new connection: the node asks for its first sync (import_request) at once, so it starts
      // now, not at the next poll.
      pollImport().catch(() => {});
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
    if (!fixed) {
      try {
        if (!root) throw new Error('this server has no wybe-connect home');
        checkSave(root, origin); // a name another node holds is refused before the browser opens
      } catch (err) {
        return text(`Could not start the sign-in: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      // Already connected to this node under the same fixed client: renew, never a second grant.
      const renewed = await renewStored(root, origin, { clientId, account: harnessAccount(), fetchImpl });
      if (renewed) {
        notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        return text(`Connected to ${renewed.credentials.nodeUrl} (scopes: ${renewed.credentials.scopes.join(', ')}); the stored grant was renewed, no new sign-in. The Wybe tools are available now.`);
      }
    }
    const state = await startConnect(origin);
    if (state.error) return text(`Could not start the sign-in: ${state.error}`, true);
    if (state.done) {
      const c = credentials();
      return text(`Connected to ${c?.nodeUrl ?? origin} (scopes: ${(c?.scopes ?? []).join(', ')}). The Wybe tools are available now.`);
    }
    return text(`A browser window is opening on the Wybe sign-in page. Ask the person to sign in with their passkey and tick what they want to share, then call connect again to confirm. If no browser opened, they can open this link: ${state.url}`);
  }

  async function callTakeTask(args, caller = null) {
    // the calling session decides the connection, as for every node tool
    if (!current(caller) || !credentials(caller)) return text('Not connected to a Wybe AI colleague, so there is no task to take.', true);
    const id = typeof args?.task_id === 'string' ? args.task_id.trim() : '';
    // the task is in the connection of the session it went to, which may not be the caller's own
    let p = current(caller);
    let found = findTask(p, id);
    if (!found && root && !fixed) {
      for (const k of connectionNames(root)) {
        const other = connectionPaths(root, k);
        found = findTask(other, id);
        if (found) { p = other; break; }
      }
    }
    if (!found) return text(`No task ${JSON.stringify(id.slice(0, 64))} from the colleague on this machine.`, true);
    const { sessionId, task } = found;
    if (task.status === 'running') return accepted(task.text);
    if (task.status !== 'offered') return text('That task is already settled; there is nothing to do for it.', true);
    const decide = async (yes) => {
      await decideTask(p, sessionId, id, yes, { fetchImpl, now });
      return yes ? accepted(task.text) : declined();
    };
    if (canElicit && request) {
      let answer;
      try {
        answer = await request('elicitation/create', {
          message: `Oppgave fra KI-kollegaen din i Wybe:\n\n${quoted(task.text)}\n\nGodta for å la denne økta gjøre den. Avvis for å si nei.`,
          requestedSchema: { type: 'object', properties: {} },
        }, ELICIT_TIMEOUT_MS);
      } catch {
        return text('The person has not answered the form. Nothing was done; call take_task again to ask once more.', true);
      }
      return decide(answer?.action === 'accept');
    }
    // A no needs no text; a yes counts only once the text has gone back to the session, so the person
    // can have seen what they say yes to. Before that, the text is shown and the question asked.
    if (args?.accepted === false || (args?.accepted === true && shown.has(id))) return decide(args.accepted);
    shown.add(id);
    return text(`This client cannot show a form, so ask the person yourself. Show them this task word for word, exactly as written: ${quoted(task.text)}. Ask whether they accept it. Do nothing for it until they give an explicit yes in this chat; then call take_task again with task_id "${id}" and accepted: true. If they say no, call take_task with accepted: false.`);
  }

  // An import request goes to the connection that answered: the call's own, never this server's default.
  const seeImport = (result, answered) => {
    const at = onImportRequest ? importRequestOf(result) : null;
    if (at && answered) {
      try {
        onImportRequest(at, answered);
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
    seeImport(out.result, current());
    return importRequestOf(out.result);
  }

  async function handleDistil(method, params, reply, fail) {
    if (method === 'tools/call' && !current()) return reply(text('This distil run has no connection to queue for.', true));
    switch (method) {
      case 'tools/list':
        return reply({ tools: DISTIL_TOOLS });
      case 'tools/call': {
        const name = params?.name;
        if (name === 'remember') {
          const cleaned = cleanRememberArgs(params?.arguments);
          if (cleaned.error) return reply(text(cleaned.error, true));
          if (cleaned.summaries.length) {
            const ours = new Set((readJson(distilPaths(current()).plan(distilRun))?.transcripts ?? []).map((t) => t?.sessionId).filter(Boolean));
            const unknown = cleaned.summaries.find((x) => !ours.has(x.sessionId));
            if (unknown) return reply(text(`session_id ${JSON.stringify(unknown.sessionId)} is not a session this run reads; nothing of this call was kept.`, true));
          }
          let r = null;
          if (cleaned.args) {
            r = spoolRemember(current(), distilRun, cleaned.args);
            if (r.error) return reply(text(r.error, true));
          }
          for (const x of cleaned.summaries) saveSummary(current(), x.sessionId, x.content);
          const kept = cleaned.summaries.length ? ` Kept ${cleaned.summaries.length} session summary(ies) on this machine.` : '';
          if (!cleaned.args) return reply(text(`Nothing queued for the colleague.${kept}`));
          return reply(text(`Queued ${cleaned.args.items.length} item(s) as call ${r.seq}. They are sent to the colleague after distil_done.${kept}`));
        }
        if (name === 'distil_done') {
          const r = spoolDone(current(), distilRun);
          if (r.error) return reply(text(r.error, true));
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
        canElicit = Boolean(params?.capabilities?.elicitation && typeof params.capabilities.elicitation === 'object');
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
        const tools = out.ok && Array.isArray(out.result?.tools) ? out.result.tools.filter((t) => t?.name !== CONNECT_TOOL.name && t?.name !== TAKE_TASK_TOOL.name) : [];
        const own = [...tools, TAKE_TASK_TOOL];
        return reply({ tools: [...(root && !fixed ? own.map((t) => withSessionId(t, idRequired())) : own), CONNECT_TOOL] });
      }
      case 'tools/call': {
        const name = params?.name;
        if (name === CONNECT_TOOL.name) return reply(await callConnect(params?.arguments));
        const raw = params?.arguments ?? {};
        const plain = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
        const { session_id: given, ...rest } = plain ? raw : {};
        const sessionId = root && !fixed && typeof given === 'string' && given.trim() ? given.trim() : null;
        // While a call could be another session's, it says which session it is; one that does not is never guessed.
        if (root && !fixed && !sessionId && idRequired()) return reply(text(NO_SESSION, true));
        // A session pinned to none (its connection was removed) fails closed: no default, no name added again.
        if (sessionId && pinnedConnection(root, sessionId) === null) {
          return reply(text(`Not delivered: this session sends to no connection. Ask the person which connection to use, then run \`connect use <name> --session ${sessionId}\` (the SessionStart note gives the full command).`, true));
        }
        // take_task passes the same session checks as every node tool, then finds its task by id in every connection.
        if (name === TAKE_TASK_TOOL.name) return reply(await callTakeTask(plain ? rest : raw, sessionId));
        if (!credentials(sessionId)) return reply(text('Not connected to a Wybe AI colleague yet. Call `connect` with the colleague\'s address first.', true));
        // Every argument passes through redactValue before it leaves the machine; one the walker
        // cannot read is refused rather than forwarded.
        let args;
        try {
          args = redactValue(plain ? rest : raw).value;
        } catch {
          return reply(text('Not delivered: the arguments could not be checked for secrets, so nothing was sent.', true));
        }
        const out = await upstream('tools/call', { name, arguments: args }, sessionId);
        if (!out.ok) {
          const why = out.kind === 'auth' ? 'the connection was refused (revoked or expired); call `connect` again' : `the AI colleague could not be reached (${out.kind}: ${out.message})`;
          return reply(text(`Not delivered: ${why}.`, true));
        }
        const questions = openQuestionsOf(out.result);
        const cp = current(sessionId);
        if (questions.length && cp) writeJsonPrivate(cp.openQuestions, { fetched_at: new Date(now()).toISOString(), open_questions: questions });
        seeImport(out.result, cp);
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
export function runStdio({ paths, root = null, env = process.env, clientId = null, clientName, input = process.stdin, output = process.stdout, distilRun = null, onImportRequest = null }) {
  const write = (m) => output.write(`${JSON.stringify(m)}\n`);
  // Requests this server sends to the client (elicitation/create for take_task): ids of their own,
  // answered by a message with that id and a result or an error, never by a method.
  const waiting = new Map();
  let seq = 0;
  const request = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    const id = `wybe-${++seq}`;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('no answer')); }, timeoutMs);
    timer.unref?.();
    waiting.set(id, { resolve, reject, timer });
    write({ jsonrpc: '2.0', id, method, params });
  });
  const proxy = createProxy({ paths, root, env, clientId, clientName, notify: write, request, distilRun, onImportRequest });
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
    if (msg && typeof msg === 'object' && msg.method === undefined && waiting.has(msg.id) && ('result' in msg || 'error' in msg)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new Error(String(msg.error?.message ?? 'error')));
      else w.resolve(msg.result);
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
