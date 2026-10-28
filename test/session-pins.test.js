// The session model (lib/connections.js), one table:
// S1 a session is the hook's session_id: /clear is a new session (WYBE_CONNECT_NODE, else the default), /resume
//    keeps its id and so its pin. Every session is told its id. Removing a connection never deletes a pin: a session
//    moved to it is pinned to none and fails closed, never sent to the default or to a name added again.
// S2 the MCP server remembers no session: with two or more connections every call names its session, and one that
//    does not is refused; with one connection the id is optional.
// S3 each transcript line goes to the node the session was on when it was written: a move starts a segment at the
//    transcript's line count, the earlier lines stay with the connection it left, and a removed one's go nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProxy, NO_SESSION } from '../lib/mcp-proxy.js';
import { connectionNames, connectionPaths, markWritten, pinnedConnection, prunePins, removeConnection, saveConnection, sessionLines, sessionNote, sessionPaths, useConnection } from '../lib/connections.js';
import * as D from '../lib/distil.js';
const { maybeRun, noteSession } = D;

const N = (c) => `https://node-${c}.example.invalid`;
const H = (c) => `node-${c}.example.invalid`;
const tok = (c) => ['wat_', c.repeat(40)].join('');
const grant = (c) => ({ version: 1, nodeUrl: N(c), resource: `${N(c)}/mcp`, mcpEndpoint: `${N(c)}/mcp`, issuer: 'https://auth.example.invalid', tokenEndpoint: 'https://auth.example.invalid/token', clientId: 'wybe-connect-claude-code', accessToken: tok(c), refreshToken: null, expiresAt: null, scopes: ['remember'] });
const req = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const remember = (id, sid) => req(id, 'tools/call', { name: 'remember', arguments: { items: [{ content: `fact ${id}` }], ...(sid ? { session_id: sid } : {}) } });

function recordingNode() {
  const calls = [];
  const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    calls.push({ url: String(url), rpc: msg.method });
    if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remember', inputSchema: { type: 'object' } }] } });
    return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
  };
  return { calls, fetchImpl };
}
const sent = (n) => n.calls.filter((c) => c.rpc === 'tools/call').map((c) => c.url);
const home = () => mkdtempSync(join(tmpdir(), 'wybe-connect-pins-'));
// Ages pins as if their last hook was at `at` (seenAt, and the file's time for a pin written before seenAt).
const setPinSeen = (root, sids, at) => {
  for (const s of sids) {
    const f = join(root, 'state', 'sessions', `${s}.json`);
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), seenAt: at }));
    utimesSync(f, at / 1000, at / 1000);
  }
};
// What a SessionStart hook does: pin, and always the note, connected or not.
const startSession = (root, sid) => {
  const p = sessionPaths(root, { sessionId: sid, env: {} });
  return { key: p.connection, note: sessionNote(root, p.connection, { sessionId: sid, command: 'connect' }) };
};
const hookNode = (root, sid, transcriptPath = null) => sessionPaths(root, { sessionId: sid, env: {}, transcriptPath }).connection;
const spawnImpl = () => ({ pid: 4242, on() {}, unref() {} });
const distilRun = (root, key, now) => maybeRun({ paths: connectionPaths(root, key), env: {}, now, alive: () => false, spawnImpl, claudeHome: join(root, 'no-claude') });
const ANY = Symbol('any connection');
const rangesOf = (plan, sid) => (plan?.transcripts ?? []).filter((t) => t.sessionId === sid).map((t) => [t.fromLine, t.toLine]);

// S opened on A with B also connected, the person moves S to B, then removes B: S is pinned to none.
function nullPinned() {
  const root = home();
  saveConnection(root, grant('a'));
  saveConnection(root, grant('b'));
  useConnection(root, H('a'));
  const S = startSession(root, 'S');
  useConnection(root, H('b'), { sessionId: 'S' });
  removeConnection(root, H('b'));
  return { root, S };
}

// S's turn 1 (one line) on A, noted for A's distil at its Stop; then `then(root)`; then turn 2 (two lines), noted at
// its Stop on wherever S's hooks go now. Returns the ranges of S each connection's next distil run reads.
function distilOfS(then) {
  const root = home();
  saveConnection(root, grant('a'));
  saveConnection(root, grant('b'));
  useConnection(root, H('a'));
  const dir = join(root, 'transcripts');
  mkdirSync(dir, { recursive: true });
  const tr = join(dir, 'S.jsonl');
  writeFileSync(tr, '{"type":"user","message":"turn 1 on A"}\n');
  const t0 = Date.now();
  const pA = sessionPaths(root, { sessionId: 'S', env: {}, transcriptPath: tr });
  assert.equal(pA.connection, H('a'));
  noteSession(pA, { transcriptPath: tr, sessionId: 'S', now: t0 });
  then(root);
  appendFileSync(tr, '{"type":"user","message":"turn 2"}\n{"type":"assistant","message":"..."}\n');
  const now = sessionPaths(root, { sessionId: 'S', env: {}, transcriptPath: tr });
  if (now.connection) noteSession(now, { transcriptPath: tr, sessionId: 'S', now: t0 + 1000 });
  const later = t0 + 7 * 3600e3;
  const names = connectionNames(root);
  return {
    a: names.includes(H('a')) ? rangesOf(distilRun(root, H('a'), later), 'S') : [],
    b: names.includes(H('b')) ? rangesOf(distilRun(root, H('b'), later), 'S') : [],
  };
}

const rows = {
  R3: async () => {
    // A move to a removed connection does not lock out a session opened meanwhile: it delivers by its id. Without
    // one the call is refused, with one connection left too, since it could be the session pinned to none.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    useConnection(root, H('b'), { sessionId: 'sess-old' });
    removeConnection(root, H('b'));
    const T = startSession(root, 'sess-T');
    assert.match(T.note, /session_id is sess-T\b/);
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    assert.equal((await proxy.handle(remember(1, null))).result.content[0].text, NO_SESSION, 'one connection, sess-old pinned to none');
    await proxy.handle(remember(2, 'sess-T'));
    saveConnection(root, grant('b'));
    assert.equal((await proxy.handle(remember(3, null))).result.content[0].text, NO_SESSION, 'two connections');
    await proxy.handle(remember(4, 'sess-T'));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('a')}/mcp`]);
  },
  R3b: async () => {
    // A session opened with one connection is told its id and delivers naming it after another is moved to B.
    const root = home();
    saveConnection(root, grant('a'));
    const T = startSession(root, 'sess-T');
    assert.equal(T.note, 'This session sends to the connection node-a.example.invalid; its session_id is sess-T.');
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    startSession(root, 'sess-V');
    useConnection(root, H('b'), { sessionId: 'sess-V' });
    assert.equal((await proxy.handle(remember(2, null))).result.isError, true, 'without an id: refused');
    await proxy.handle(remember(3, 'sess-T'));
    await proxy.handle(remember(4, 'sess-V'));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('b')}/mcp`]);
  },
  R4a: async () => {
    // S moved to B, B removed: S is pinned to none (hooks and tools), never to the default A, and stays so when B comes back.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    assert.equal(hookNode(root, 'S'), H('a'));
    useConnection(root, H('b'), { sessionId: 'S' });
    useConnection(root, H('b'));
    assert.equal(hookNode(root, 'Q'), H('b'));
    useConnection(root, H('a'));
    removeConnection(root, H('b'));
    assert.equal(pinnedConnection(root, 'S'), null, 'the pin is kept, pinned to none');
    assert.equal(hookNode(root, 'Q'), null, 'control: a session opened on B stays unconnected');
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    const r = await proxy.handle(remember(1, 'S'));
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /connect use <name>/);
    assert.equal(hookNode(root, 'S'), null);
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    await proxy.handle(remember(2, 'S'));
    assert.equal(hookNode(root, 'S'), null, 'B added again: S is still pinned to none');
    assert.deepEqual(sent(node), []);
    assert.match(startSession(root, 'S').note, /connect use <name> --session S$/);
  },
  R4b: async () => {
    // S moved to "work" (node X); "work" removed and connected again to node Y: S sends nowhere, never to Y.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('x'), { name: 'work' });
    useConnection(root, H('a'));
    useConnection(root, 'work', { sessionId: 'S' });
    assert.equal(hookNode(root, 'S'), 'work');
    removeConnection(root, 'work');
    saveConnection(root, grant('y'), { name: 'work' });
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    const r = await proxy.handle(remember(1, 'S'));
    assert.match(r.result.content[0].text, /connect use <name>/);
    assert.equal(hookNode(root, 'S'), null);
    assert.deepEqual(sent(node), []);
    // Positive control: choosing a connection again moves S there.
    useConnection(root, 'work', { sessionId: 'S' });
    await proxy.handle(remember(2, 'S'));
    assert.deepEqual(sent(node), [`${N('y')}/mcp`]);
  },
  R4c: async () => {
    // A session opened before any connection (the first-run connect) is told its id, so a later move does not lock it out.
    const root = home();
    const T = startSession(root, 'sess-T');
    assert.equal(T.key, null);
    assert.match(T.note ?? '', /session_id is sess-T\b/);
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    saveConnection(root, grant('a'));
    assert.equal(hookNode(root, 'sess-T'), H('a'));
    await proxy.handle(req(0, 'tools/list'));
    await proxy.handle(remember(1, null));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    startSession(root, 'sess-V');
    useConnection(root, H('b'), { sessionId: 'sess-V' });
    assert.equal((await proxy.handle(remember(2, null))).result.isError, true, 'without an id: refused');
    await proxy.handle(remember(3, 'sess-T'));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('a')}/mcp`]);
  },
  pinnedToNone: async () => {
    // R4a through the server: S pinned to B, B removed, A alone. S is refused with its id, and a call without one
    // is refused too (it could be S's), never sent to A. Once S chooses A, every pin is on A and the id is optional.
    const { root } = nullPinned();
    assert.equal(pinnedConnection(root, 'S'), null);
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    const listed = (await proxy.handle(req(0, 'tools/list'))).result.tools.find((t) => t.name === 'remember');
    assert.deepEqual(listed.inputSchema.required, ['session_id']);
    assert.match((await proxy.handle(remember(1, 'S'))).result.content[0].text, /connect use <name> --session S/);
    assert.equal((await proxy.handle(remember(2, null))).result.content[0].text, NO_SESSION);
    assert.deepEqual(sent(node), []);
    useConnection(root, H('a'), { sessionId: 'S' });
    await proxy.handle(remember(3, null));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`]);
  },
  pinnedToAnotherName: async () => {
    // One connection, and a session fixed to a name that now holds another node: a call without an id is refused.
    const root = home();
    saveConnection(root, grant('x'), { name: 'work' });
    useConnection(root, 'work', { sessionId: 'S' });
    removeConnection(root, 'work');
    saveConnection(root, grant('y'), { name: 'work' });
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    assert.equal((await proxy.handle(remember(1, null))).result.content[0].text, NO_SESSION);
    assert.deepEqual(sent(node), []);
  },
  clearAfterMove: () => {
    // /clear gives a new session_id: a new session, where any new one goes; it never inherits the old one's move.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    startSession(root, 'S1');
    useConnection(root, H('b'), { sessionId: 'S1' });
    assert.equal(startSession(root, 'S2').key, H('a'), 'the default');
    assert.equal(sessionPaths(root, { sessionId: 'S3', env: { WYBE_CONNECT_NODE: H('b') } }).connection, H('b'), 'WYBE_CONNECT_NODE in that terminal');
    assert.equal(hookNode(root, 'S1'), H('b'), 'control: the moved session itself stays on B');
  },
  idlessTwo: async () => {
    // Two connections: session_id is required on every node tool, and a call without it is refused in one line,
    // never guessed: not the default, not the session that called last (the server outlives /clear).
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    startSession(root, 'S1');
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    const listed = (await proxy.handle(req(0, 'tools/list'))).result.tools.find((t) => t.name === 'remember');
    assert.deepEqual(listed.inputSchema.required, ['session_id']);
    useConnection(root, H('b'), { sessionId: 'S1' });
    await proxy.handle(remember(1, 'S1'));
    startSession(root, 'S2'); // /clear: same server process
    const r = await proxy.handle(remember(2, null));
    assert.equal(r.result.content[0].text, NO_SESSION);
    assert.equal(r.result.isError, true);
    await proxy.handle(remember(3, 'S2'));
    assert.deepEqual(sent(node), [`${N('b')}/mcp`, `${N('a')}/mcp`]);
  },
  idlessOne: async () => {
    // One connection: session_id is optional and every call goes there.
    const root = home();
    saveConnection(root, grant('a'));
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    const listed = (await proxy.handle(req(0, 'tools/list'))).result.tools.find((t) => t.name === 'remember');
    assert.equal(listed.inputSchema.required, undefined);
    assert.equal(typeof listed.inputSchema.properties.session_id, 'object');
    await proxy.handle(remember(1, null));
    await proxy.handle(remember(2, 't1'));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('a')}/mcp`]);
  },
  unseenId: async () => {
    // A named id this machine has never seen goes where a new session goes. The proxy never writes a pin: only the
    // hooks (which know the transcript) and `connect use` do, so the id follows the default until a hook fixes it.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('b'));
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    await proxy.handle(remember(1, 'never-seen'));
    assert.equal(pinnedConnection(root, 'never-seen'), undefined, 'the proxy wrote a pin');
    useConnection(root, H('a'));
    await proxy.handle(remember(2, 'never-seen'));
    assert.deepEqual(sent(node), [`${N('b')}/mcp`, `${N('a')}/mcp`]);
    assert.equal(hookNode(root, 'never-seen'), H('a'), 'control: a hook does fix it');
  },
  importToAnswering: async () => {
    // An import in a reply goes to the connection that answered the call (the one its session_id resolved to), never
    // to the proxy's default.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    startSession(root, 'S');
    useConnection(root, H('b'), { sessionId: 'S' });
    const node = recordingNode();
    const asking = async (url, init = {}) => {
      const msg = init.body ? JSON.parse(init.body) : null;
      if (msg?.method !== 'tools/call') return node.fetchImpl(url, init);
      await node.fetchImpl(url, init);
      const result = { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { import_request: { requested_at: new Date(0).toISOString() } } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const seen = [];
    const proxy = createProxy({ root, env: {}, fetchImpl: asking, onImportRequest: (at, p) => seen.push(p?.connection ?? null) });
    await proxy.handle(req(0, 'tools/list'));
    await proxy.handle(remember(1, 'S'));
    assert.deepEqual(sent(node), [`${N('b')}/mcp`], 'control: B answered');
    assert.deepEqual(seen, [H('b')]);
  },
  beforeAnyConnection: () => {
    // The one stated exception to "each line goes to the node it was written on": lines written before any connection
    // existed go to the first connection, from line 0. No node had them, so nothing crosses between nodes; this is the
    // first-run import (the node gets the person's context from the start).
    const root = home();
    const dir = join(root, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const tr = join(dir, 'S.jsonl');
    writeFileSync(tr, 'before1\nbefore2\n');
    assert.equal(hookNode(root, 'S', tr), null);
    assert.equal(pinnedConnection(root, 'S'), undefined, 'not fixed while there is no connection');
    saveConnection(root, grant('a'));
    appendFileSync(tr, 'a1\n');
    const p = sessionPaths(root, { sessionId: 'S', env: {}, transcriptPath: tr });
    assert.equal(p.connection, H('a'));
    noteSession(p, { transcriptPath: tr, sessionId: 'S', now: Date.now() });
    assert.deepEqual(sessionLines(root, 'S', H('a')), [[0, null]]);
    assert.deepEqual(rangesOf(distilRun(root, H('a'), Date.now() + 7 * 3600e3), 'S'), [[0, 3]]);
  },
  stayOnA: () => {
    // Turn 1 was written on A, turn 2 after the move to B: A keeps line 0, B starts at the boundary, never at 0.
    assert.deepEqual(distilOfS(() => {}), { a: [[0, 3]], b: [] }, 'control: no move, A reads all of it');
    assert.deepEqual(distilOfS((root) => useConnection(root, H('b'), { sessionId: 'S' })), { a: [[0, 1]], b: [[1, 3]] });
    assert.deepEqual(distilOfS((root) => useConnection(root, H('a'), { sessionId: 'S' })), { a: [[0, 3]], b: [] }, 'moved to A itself');
  },
  removedGoesNowhere: () => {
    // A removed connection's unsent lines are dropped, never sent to the connection the session moved to.
    assert.deepEqual(distilOfS((root) => {
      useConnection(root, H('b'), { sessionId: 'S' });
      removeConnection(root, H('a'));
    }), { a: [], b: [[1, 3]] }, 'A removed after the move');
    assert.deepEqual(distilOfS((root) => {
      useConnection(root, H('b'), { sessionId: 'S' });
      removeConnection(root, H('b'));
    }), { a: [[0, 1]], b: [] }, 'B removed: A still has its own line');
  },
  removedThenAddedAgain: () => {
    // A removed after S left it, then connected again (the same node): S's lines from its stay on A still go nowhere.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    const dir = join(root, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const tr = join(dir, 'S.jsonl');
    writeFileSync(tr, 'a1\n');
    hookNode(root, 'S', tr);
    useConnection(root, H('b'), { sessionId: 'S' });
    appendFileSync(tr, 'b1\n');
    assert.deepEqual(sessionLines(root, 'S', H('a')), [[0, 1]], 'control: A has its stay');
    removeConnection(root, H('a'));
    saveConnection(root, grant('a'));
    assert.deepEqual(sessionLines(root, 'S', H('a')), []);
    assert.deepEqual(sessionLines(root, 'S', H('b')), [[1, null]]);
  },
  noteRecordsTranscript: () => {
    // A session resolved without its transcript (the MCP server's first call) learns it from its distil note, so a
    // later move still has a boundary.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    const dir = join(root, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const tr = join(dir, 'S.jsonl');
    writeFileSync(tr, 'a1\n');
    noteSession(sessionPaths(root, { sessionId: 'S', env: {} }), { transcriptPath: tr, sessionId: 'S' });
    useConnection(root, H('b'), { sessionId: 'S' });
    assert.deepEqual(sessionLines(root, 'S', H('a')), [[0, 1]]);
    assert.deepEqual(sessionLines(root, 'S', H('b')), [[1, null]]);
  },
  twoMoves: () => {
    // A -> B -> A: one segment per stay, each line to the node it was written on.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    const dir = join(root, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const tr = join(dir, 'S.jsonl');
    writeFileSync(tr, 'a1\n');
    noteSession(sessionPaths(root, { sessionId: 'S', env: {}, transcriptPath: tr }), { transcriptPath: tr, sessionId: 'S' });
    useConnection(root, H('b'), { sessionId: 'S' });
    appendFileSync(tr, 'b1\nb2\n');
    noteSession(sessionPaths(root, { sessionId: 'S', env: {} }), { transcriptPath: tr, sessionId: 'S' });
    useConnection(root, H('a'), { sessionId: 'S' });
    appendFileSync(tr, 'a2\n');
    const pin = JSON.parse(readFileSync(join(root, 'state', 'sessions', 'S.json'), 'utf8'));
    assert.deepEqual(pin.segments.map((s) => [s.connection, s.fromLine]), [[H('a'), 0], [H('b'), 1], [H('a'), 3]]);
    const later = Date.now() + 7 * 3600e3;
    assert.deepEqual(rangesOf(distilRun(root, H('a'), later), 'S'), [[0, 1]], 'A reads its first stay');
    assert.equal(D.loadState(connectionPaths(root, H('a'))).pending.filter((x) => x.sessionId === 'S').length, 1, 'and keeps S pending for its second');
    assert.deepEqual(rangesOf(distilRun(root, H('b'), later), 'S'), [[1, 3]]);
  },
  fuzz: async () => {
    // Random connects, defaults, moves, removes and new sessions, a turn per open session each step and every
    // connection's distil run: no tool call or distil line ever reaches another node than the one the session was on
    // when that line was written, a call without an id is refused while there are several connections, and an open
    // session naming itself is never locked out.
    const locked = [];
    const crossed = [];
    for (let seed = 1; seed <= 200; seed++) {
      let st = (seed * 7919) >>> 0;
      const r = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const root = home();
      const dir = join(root, 'tr');
      mkdirSync(dir, { recursive: true });
      const log = [];
      const open = [];
      let clock = Date.now();
      for (let step = 0; step < 10; step++) {
        const names = connectionNames(root);
        const c = 'abc'[Math.floor(r() * 3)];
        const op = Math.floor(r() * 6);
        try {
          if (op === 0) { saveConnection(root, grant(c)); log.push(`connect ${c}`); }
          else if (op === 1 && names.includes(H(c))) { useConnection(root, H(c)); log.push(`use ${c}`); }
          else if (op === 2 && names.includes(H(c)) && open.length) {
            const t = open[Math.floor(r() * open.length)];
            useConnection(root, H(c), { sessionId: t.sid });
            log.push(`use ${c} --session ${t.sid}`);
          } else if (op === 3 && names.includes(H(c))) { removeConnection(root, H(c)); log.push(`remove ${c}`); }
          else if (op >= 4) {
            const sid = `t${open.length}`;
            const tr = join(dir, `${sid}.jsonl`);
            writeFileSync(tr, '');
            const s = startSession(root, sid);
            assert.match(s.note ?? '', new RegExp(`${sid}\\b`), `note without id: ${s.note}`);
            const node = recordingNode();
            const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
            await proxy.handle(req(0, 'tools/list'));
            open.push({ sid, tr, proxy, node, owners: [] });
            log.push(`open ${sid}`);
          }
        } catch (e) {
          if (e.code === 'ERR_ASSERTION') throw e;
          log.push(`(${e.message})`);
        }
        for (const t of open) {
          const k = hookNode(root, t.sid, t.tr);
          appendFileSync(t.tr, `{"type":"user","message":"${t.sid} step ${step}"}\n`);
          // a line written while the session is not fixed yet (no connection at all) is the person's, for any
          t.owners.push(k ?? (pinnedConnection(root, t.sid) === undefined ? ANY : null));
          if (k) noteSession(connectionPaths(root, k), { transcriptPath: t.tr, sessionId: t.sid, now: clock });
          const before = sent(t.node).length;
          await t.proxy.handle(remember(2, t.sid));
          const got = sent(t.node).slice(before);
          for (const g of got) if (g !== `https://${k}/mcp`) crossed.push(`seed ${seed} ${t.sid} named -> ${g} (hook ${k}): ${log.join('; ')}`);
          if (k && !got.length) locked.push(`seed ${seed} ${t.sid}: ${log.join('; ')}`);
          // A call without an id may go only where it cannot be another session's: one connection, every session on it.
          const now = connectionNames(root);
          if (now.length) {
            const required = now.length > 1 || open.some((o) => pinnedConnection(root, o.sid) === null);
            const b2 = sent(t.node).length;
            const idless = await t.proxy.handle(remember(3, null));
            const went = sent(t.node).slice(b2);
            if (required && (went.length || idless.result.content[0].text !== NO_SESSION)) crossed.push(`seed ${seed} ${t.sid} id-less delivered: ${log.join('; ')}`);
            if (!required && went.join() !== `https://${now[0]}/mcp`) crossed.push(`seed ${seed} ${t.sid} id-less with one connection -> ${went}: ${log.join('; ')}`);
          }
        }
        clock += 7 * 3600e3;
        for (const name of connectionNames(root)) {
          for (const range of distilRun(root, name, clock)?.transcripts ?? []) {
            const t = open.find((o) => o.sid === range.sessionId);
            for (let line = range.fromLine; line < range.toLine; line++) {
              if (t.owners[line] !== name && t.owners[line] !== ANY) crossed.push(`seed ${seed} distil ${name} reads ${t.sid} line ${line} (written on ${t.owners[line]}): ${log.join('; ')}`);
            }
          }
        }
      }
    }
    assert.deepEqual({ locked: locked.slice(0, 3), crossed: crossed.slice(0, 3), n: locked.length + crossed.length }, { locked: [], crossed: [], n: 0 });
  },
  nullPin: async () => {
    // Pinned to none survives another remove, the same name added again and a default change; `use` clears it.
    const { root, S } = nullPinned();
    assert.match(S.note, /--session S$/);
    assert.equal(hookNode(root, 'S'), null);
    assert.match(startSession(root, 'S').note, /sends to no connection; its session_id is S\. .*use <name> --session S$/);
    saveConnection(root, grant('c'));
    removeConnection(root, H('c'));
    saveConnection(root, grant('b'));
    assert.equal(hookNode(root, 'S'), null);
    useConnection(root, H('a'));
    assert.equal(hookNode(root, 'S'), null);
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    const r = await proxy.handle(remember(1, 'S'));
    assert.match(r.result.content[0].text, /connect use <name> --session S/);
    assert.deepEqual(sent(node), []);
    useConnection(root, H('b'), { sessionId: 'S' });
    assert.equal(hookNode(root, 'S'), H('b'));
    await proxy.handle(remember(2, 'S'));
    assert.deepEqual(sent(node), [`${N('b')}/mcp`]);
  },
  everyday: async () => {
    // One connection, no moves: session start, a call without session_id and one with it all go to A.
    const root = home();
    saveConnection(root, grant('a'));
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    await proxy.handle(remember(1, null));
    assert.equal(startSession(root, 't1').key, H('a'));
    await proxy.handle(remember(2, null));
    await proxy.handle(remember(3, 't1'));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('a')}/mcp`, `${N('a')}/mcp`]);
  },
  prune: () => {
    // A pin lives as long as its transcript: pruned when it is gone, kept while it exists or is not known.
    const root = home();
    saveConnection(root, grant('a'));
    const dir = join(root, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const gone = join(dir, 'gone.jsonl');
    const kept = join(dir, 'kept.jsonl');
    writeFileSync(gone, 'x\n');
    writeFileSync(kept, 'x\n');
    hookNode(root, 'gone', gone);
    hookNode(root, 'kept', kept);
    hookNode(root, 'unknown', join(dir, 'not-written-yet.jsonl'));
    hookNode(root, 'idle', join(dir, 'idle-not-written.jsonl'));
    rmSync(gone);
    const t0 = Date.now();
    prunePins(root, t0);
    assert.equal(pinnedConnection(root, 'gone'), undefined);
    assert.equal(pinnedConnection(root, 'kept'), H('a'));
    assert.equal(pinnedConnection(root, 'unknown'), H('a'), 'a pin with no transcript has a grace');
    // A pin with no transcript lives 24 hours from the last hook that resolved it; one with a transcript is not timed.
    const day = 24 * 3600e3;
    setPinSeen(root, ['unknown', 'idle', 'kept'], t0 - day - 60e3);
    hookNode(root, 'unknown', join(dir, 'not-written-yet.jsonl'));
    prunePins(root, t0);
    assert.equal(pinnedConnection(root, 'idle'), undefined, 'no transcript, no hook for over 24 hours');
    assert.equal(pinnedConnection(root, 'unknown'), H('a'), 'a hook resolved it just now');
    assert.equal(pinnedConnection(root, 'kept'), H('a'), 'a pin with a transcript lives as long as it');
  },
};

for (const [name, row] of Object.entries(rows)) test(`session pins ${name}`, row);

// R4c through the real hooks: each harness's SessionStart gives the id with no connection at all.
const ROOT = join(import.meta.dirname, '..');
function runHook(script, input, root) {
  return new Promise((resolve, reject) => {
    const base = { ...process.env };
    delete base.WYBE_CONNECT_NODE;
    const child = spawn(process.execPath, [join(ROOT, script)], { env: { ...base, WYBE_CONNECT_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
    child.stdin.end(JSON.stringify(input));
  });
}
const HOOKS = {
  'claude-code': ['packages/claude-code/hooks/session-start.js', { session_id: 'sess-first', hook_event_name: 'SessionStart', source: 'startup' }, (o) => o.hookSpecificOutput?.additionalContext],
  codex: ['packages/codex/hooks/session-start.js', { session_id: 'sess-first', hook_event_name: 'SessionStart', source: 'startup' }, (o) => o.hookSpecificOutput?.additionalContext],
  cursor: ['packages/cursor/hooks/on-event.js', { conversation_id: 'sess-first', hook_event_name: 'sessionStart' }, (o) => o.additional_context],
};
for (const [harness, [script, input, context]] of Object.entries(HOOKS)) {
  test(`session pins R4c, ${harness} hook: a session opened before any connection is told its id`, async () => {
    const out = await runHook(script, input, home());
    assert.equal(context(JSON.parse(out || '{}')), 'This session is not connected yet; its session_id is sess-first.');
  });
}

// Cursor through the real hook: each spool record is kept for the connection in use when it was written and is
// delivered only there, so a record from before a move never reaches the node the conversation moved to.
function httpNode() {
  const seen = [];
  const server = createServer((rq, rs) => {
    let body = '';
    rq.on('data', (d) => { body += d; });
    rq.on('end', () => {
      const msg = body ? JSON.parse(body) : null;
      if (rq.method === 'DELETE') { rs.writeHead(200).end(); return; }
      if (msg.method === 'initialize') { rs.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })); return; }
      if (msg.method === 'notifications/initialized') { rs.writeHead(202).end(); return; }
      seen.push(JSON.stringify(msg.params ?? null));
      rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}
test('session pins cursorSpool: a record goes only to the connection in use when it was written', async () => {
  const [a, b] = [await httpNode(), await httpNode()];
  try {
    const root = home();
    const cursorHome = join(root, 'cursor');
    const g = (n) => ({ ...grant('a'), nodeUrl: n.base, resource: `${n.base}/mcp`, mcpEndpoint: `${n.base}/mcp`, scopes: ['sessions:light'] });
    const kA = saveConnection(cursorHome, g(a));
    const kB = saveConnection(cursorHome, g(b));
    useConnection(cursorHome, kA);
    const ev = (hook_event_name, more = {}) => runHook(HOOKS.cursor[0], { conversation_id: 'S', hook_event_name, workspace_roots: [], ...more }, root);
    await ev('sessionStart');
    await ev('beforeSubmitPrompt', { prompt: 'WRITTEN-ON-A' });
    useConnection(cursorHome, kB, { sessionId: 'S' });
    await ev('beforeSubmitPrompt', { prompt: 'WRITTEN-ON-B' });
    await ev('stop', { status: 'completed', loop_count: 0 });
    const got = (n) => ({ a: n.seen.some((s) => s.includes('WRITTEN-ON-A')), b: n.seen.some((s) => s.includes('WRITTEN-ON-B')) });
    assert.deepEqual({ a: got(a), b: got(b) }, { a: { a: true, b: false }, b: { a: false, b: true } });
  } finally {
    a.server.close();
    b.server.close();
  }
});

// The proxy keeps no default of its own: an id-less call goes where a new session goes at that call, so a server that
// first met A still delivers to B once B is the only connection and every pin is on it.
test('session pins noCachedDefault: one connection left, every pin on it, an id-less call reaches it and its tools are listed', async () => {
  const root = home();
  saveConnection(root, grant('a'));
  hookNode(root, 'S');
  const node = recordingNode();
  const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
  await proxy.handle(req(0, 'tools/list'));
  await proxy.handle(remember(1, null));
  saveConnection(root, grant('b'));
  removeConnection(root, H('a'));
  useConnection(root, H('b'), { sessionId: 'S' });
  const r = await proxy.handle(remember(2, null));
  const listed = (await proxy.handle(req(3, 'tools/list'))).result.tools.map((t) => t.name);
  assert.deepEqual({ sent: sent(node), error: r.result.isError ?? false, lists: listed.includes('remember') }, { sent: [`${N('a')}/mcp`, `${N('b')}/mcp`], error: false, lists: true });
});

// A SessionStart may come before Claude Code has written the transcript file. The pin keeps that path anyway, so a move
// in the session's first turn still counts its lines: A keeps them and B starts at the boundary.
test('session pins firstTurnMove: a transcript written after SessionStart still gives the move its boundary', () => {
  const root = home();
  saveConnection(root, grant('b'));
  saveConnection(root, grant('a'));
  const dir = join(root, 'tr');
  mkdirSync(dir, { recursive: true });
  const tr = join(dir, 'S.jsonl');
  assert.equal(hookNode(root, 'S', tr), H('a'));
  for (let i = 0; i < 4; i++) appendFileSync(tr, `{"type":"user","message":"line ${i}"}\n`);
  useConnection(root, H('b'), { sessionId: 'S' });
  appendFileSync(tr, '{"type":"user","message":"line 4"}\n');
  assert.equal(hookNode(root, 'S', tr), H('b'));
  assert.deepEqual({ a: sessionLines(root, 'S', H('a')), b: sessionLines(root, 'S', H('b')) }, { a: [[0, 4]], b: [[4, null]] });
});

// The 24 hours of a pin with no transcript run from the last hook that resolved it; removing a connection or moving the
// session rewrites the pin but does not renew it. Cursor's sessionStart prunes too.
test('session pins pruneClock: remove and move do not renew a pin; Cursor prunes at sessionStart', async () => {
  const root = home();
  saveConnection(root, grant('a'));
  saveConnection(root, grant('b'));
  saveConnection(root, grant('c'));
  hookNode(root, 'idle', join(root, 'never-written.jsonl'));
  const day = 24 * 3600e3;
  setPinSeen(root, ['idle'], Date.now() - day - 60e3);
  useConnection(root, H('b'), { sessionId: 'idle' });
  removeConnection(root, H('c'));
  prunePins(root);
  assert.equal(pinnedConnection(root, 'idle'), undefined, 'a move and a remove renewed the pin');
  const cursorHome = join(root, 'cursor');
  saveConnection(cursorHome, grant('a'));
  sessionPaths(cursorHome, { sessionId: 'old', env: {} });
  setPinSeen(cursorHome, ['old'], Date.now() - day - 60e3);
  await runHook(HOOKS.cursor[0], { conversation_id: 'new', hook_event_name: 'sessionStart' }, root);
  assert.equal(pinnedConnection(cursorHome, 'old'), undefined, 'Cursor\'s sessionStart did not prune');
  assert.equal(pinnedConnection(cursorHome, 'new'), H('a'));
});

// The 24 hours are only the grace for a session that has not written yet. A Cursor conversation has no transcript, so
// its first spooled record marks its pin written; from then on the pin is not timed, and a null pin or a move holds.
const cursorDay = async (moveToB) => {
  const [a, b] = [await httpNode(), await httpNode()];
  try {
    const root = home();
    const ch = join(root, 'cursor');
    const g = (n) => ({ ...grant('a'), nodeUrl: n.base, resource: `${n.base}/mcp`, mcpEndpoint: `${n.base}/mcp`, scopes: ['sessions:light'] });
    const kA = saveConnection(ch, g(a));
    const kB = saveConnection(ch, g(b));
    useConnection(ch, kA);
    const ev = (sid, hook_event_name, more = {}) => runHook(HOOKS.cursor[0], { conversation_id: sid, hook_event_name, workspace_roots: [], ...more }, root);
    const turn = async (sid, prompt) => { await ev(sid, 'beforeSubmitPrompt', { prompt }); await ev(sid, 'stop', { status: 'completed', loop_count: 0 }); };
    await ev('S', 'sessionStart');
    if (moveToB) useConnection(ch, kB, { sessionId: 'S' });
    await turn('S', 'DAY-ONE');
    if (!moveToB) removeConnection(ch, kA);
    setPinSeen(ch, ['S'], Date.now() - 25 * 3600e3);
    await ev('T', 'sessionStart');
    await turn('S', 'NEXT-DAY');
    const got = (n, s) => n.seen.some((x) => x.includes(s));
    return { dayOneOnB: got(b, 'DAY-ONE'), nextDayOnA: got(a, 'NEXT-DAY'), nextDayOnB: got(b, 'NEXT-DAY') };
  } finally {
    a.server.close();
    b.server.close();
  }
};
test('session pins cursorWrittenNullPin: a Cursor conversation pinned to none still sends nowhere a day later', async () => {
  assert.deepEqual(await cursorDay(false), { dayOneOnB: false, nextDayOnA: false, nextDayOnB: false });
});
test('session pins cursorWrittenMove: a Cursor conversation moved to B is still on B a day later', async () => {
  assert.deepEqual(await cursorDay(true), { dayOneOnB: true, nextDayOnA: false, nextDayOnB: true });
});
test('session pins writtenSurvivesMove: a move after the conversation wrote keeps its pin untimed', () => {
  const root = home();
  saveConnection(root, grant('a'));
  saveConnection(root, grant('b'));
  useConnection(root, H('a'));
  sessionPaths(root, { sessionId: 'S', env: {} });
  markWritten(root, 'S');
  useConnection(root, H('b'), { sessionId: 'S' });
  setPinSeen(root, ['S'], Date.now() - 25 * 3600e3);
  prunePins(root);
  assert.equal(pinnedConnection(root, 'S'), H('b'));
});
test('session pins pendingWritten: a transcript first given before it existed keeps its pin once written, a day later too', () => {
  const root = home();
  saveConnection(root, grant('a'));
  const dir = join(root, 'tr');
  mkdirSync(dir, { recursive: true });
  const tr = join(dir, 'S.jsonl');
  assert.equal(hookNode(root, 'S', tr), H('a'));
  appendFileSync(tr, '{"type":"user","message":"line 0"}\n{"type":"user","message":"line 1"}\n');
  prunePins(root, Date.now() + 25 * 3600e3);
  saveConnection(root, grant('b'));
  hookNode(root, 'S', tr);
  assert.deepEqual({ pin: pinnedConnection(root, 'S'), b: sessionLines(root, 'S', H('b')) }, { pin: H('a'), b: [] });
});

// Codex sends the rollout from its Stop hook. Each connection reads only the lines the session wrote while on it, from a
// cursor of its own: a turn written on A before `connect use B --session` goes to A at the next Stop, never to B.
test('session pins codexStop: a turn written on A before the move goes to A, the rest to B', async () => {
  const [a, b] = [await httpNode(), await httpNode()];
  try {
    const root = home();
    const codexHome = join(root, 'codex');
    const g = (n) => ({ ...grant('a'), nodeUrl: n.base, resource: `${n.base}/mcp`, mcpEndpoint: `${n.base}/mcp`, scopes: ['sessions:full'] });
    const kB = saveConnection(codexHome, g(b));
    const kA = saveConnection(codexHome, g(a));
    const sid = '0190c0de-0000-7000-8000-00000000c0de';
    const project = join(root, 'atlas-demo');
    mkdirSync(join(project, '.git'), { recursive: true });
    const lines = readFileSync(join(import.meta.dirname, 'fixtures', 'codex-rollout.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => `${l}\n`);
    const rollout = join(root, `rollout-2026-01-01T00-00-00-${sid}.jsonl`);
    writeFileSync(rollout, lines.slice(0, 21).join(''));
    const ev = (name, more = {}) => ({ session_id: sid, transcript_path: rollout, cwd: project, hook_event_name: name, model: 'm', permission_mode: 'default', ...more });
    await runHook('packages/codex/hooks/session-start.js', ev('SessionStart', { source: 'startup' }), root);
    await runHook('packages/codex/hooks/flush.js', ev('Stop', { turn_id: 'turn-1' }), root);
    assert.equal(a.seen.length, 1, 'control: turn 1 went to A');
    appendFileSync(rollout, lines.slice(21, 24).join(''));
    useConnection(codexHome, kB, { sessionId: sid });
    appendFileSync(rollout, lines.slice(24).join(''));
    await runHook('packages/codex/hooks/flush.js', ev('Stop', { turn_id: 'turn-2' }), root);
    const toB = b.seen.join('\n');
    const toA = a.seen.slice(1).join('\n');
    assert.ok(b.seen.length >= 1, 'control: B got the part after the move');
    assert.deepEqual({ onB: toB.includes('cap the retries at five'), onA: toA.includes('cap the retries at five') }, { onB: false, onA: true });
    assert.equal(kA, connectionNames(codexHome).find((k) => k === kA));
  } finally {
    a.server.close();
    b.server.close();
  }
});

// /resume through the real hook, with SessionStart inputs copied from a real Claude Code run: the resumed session
// keeps its session_id, so it keeps its pin (here, a move to B); a startup input with a new id goes to the default.
test('session pins resume: a resumed session keeps its id, and so its move', async () => {
  const [startup, resume] = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-code-session-start.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(resume.source, 'resume');
  assert.equal(resume.session_id, startup.session_id, 'Claude Code resumes under the same id');
  assert.equal(resume.transcript_path, startup.transcript_path);
  const root = home();
  saveConnection(root, grant('a'));
  saveConnection(root, grant('b'));
  useConnection(root, H('a'));
  await runHook(HOOKS['claude-code'][0], startup, root);
  assert.equal(pinnedConnection(root, startup.session_id), H('a'));
  useConnection(root, H('b'), { sessionId: startup.session_id });
  const out = JSON.parse(await runHook(HOOKS['claude-code'][0], resume, root) || '{}');
  assert.match(out.hookSpecificOutput?.additionalContext ?? '', new RegExp(`sends to the connection node-b\\.example\\.invalid;.*session_id is ${resume.session_id}`));
  const fresh = JSON.parse(await runHook(HOOKS['claude-code'][0], { ...startup, session_id: 'after-clear', source: 'clear' }, root) || '{}');
  assert.match(fresh.hookSpecificOutput?.additionalContext ?? '', /sends to the connection node-a\.example\.invalid;.*session_id is after-clear/);
});
