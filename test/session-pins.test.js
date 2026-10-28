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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProxy, NO_SESSION } from '../lib/mcp-proxy.js';
import { connectionNames, connectionPaths, pinnedConnection, prunePins, removeConnection, saveConnection, sessionLines, sessionNote, sessionPaths, useConnection } from '../lib/connections.js';
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
    // A named id this machine has never seen goes where a new session goes, and is fixed there.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('b'));
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    await proxy.handle(remember(1, 'never-seen'));
    useConnection(root, H('a'));
    await proxy.handle(remember(2, 'never-seen'));
    assert.deepEqual(sent(node), [`${N('b')}/mcp`, `${N('b')}/mcp`]);
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
    rmSync(gone);
    prunePins(root);
    assert.equal(pinnedConnection(root, 'gone'), undefined);
    assert.equal(pinnedConnection(root, 'kept'), H('a'));
    assert.equal(pinnedConnection(root, 'unknown'), H('a'), 'a transcript not written yet is never recorded, so never pruned');
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
