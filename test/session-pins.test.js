// One rule for session pins (lib/connections.js): every session is told its id, including one opened before
// any connection existed; removing a connection never deletes a pin, a session moved to it is pinned to none;
// and a session pinned to none fails closed, never sent to the default or to a connection added again under
// the same name. Its calls say to choose one with `connect use <name>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProxy } from '../lib/mcp-proxy.js';
import { connectionNames, connectionPaths, pinnedConnection, removeConnection, saveConnection, sessionNote, sessionPaths, useConnection } from '../lib/connections.js';
import { maybeRun, noteSession } from '../lib/distil.js';

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
const hookNode = (root, sid) => sessionPaths(root, { sessionId: sid, env: {} }).connection;

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

// S's transcript noted for A's distil at its first Stop (one line), then `then(root)`, then a second turn; returns
// the ranges of S that A's next distil run would read.
function distilOfS(then) {
  const root = home();
  saveConnection(root, grant('a'));
  saveConnection(root, grant('b'));
  useConnection(root, H('a'));
  const dir = join(root, 'transcripts');
  mkdirSync(dir, { recursive: true });
  const tr = join(dir, 'S.jsonl');
  writeFileSync(tr, '{"type":"user","message":"turn 1 on A"}\n');
  const pA = sessionPaths(root, { sessionId: 'S', env: {} });
  assert.equal(pA.connection, H('a'));
  noteSession(pA, { transcriptPath: tr, sessionId: 'S', now: Date.now() });
  then(root);
  appendFileSync(tr, '{"type":"user","message":"turn 2"}\n{"type":"assistant","message":"..."}\n');
  const spawnImpl = () => ({ pid: 4242, on() {}, unref() {} });
  const plan = maybeRun({ paths: connectionPaths(root, H('a')), env: {}, now: Date.now() + 7 * 3600e3, spawnImpl, claudeHome: join(root, 'no-claude') });
  return (plan?.transcripts ?? []).filter((t) => t.sessionId === 'S').map((t) => [t.fromLine, t.toLine]);
}

const rows = {
  R3: async () => {
    // A move to a removed connection does not lock out a session opened meanwhile, with or without its id.
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
    await proxy.handle(remember(1, null));
    saveConnection(root, grant('b'));
    await proxy.handle(remember(2, null));
    await proxy.handle(remember(3, 'sess-T'));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('a')}/mcp`, `${N('a')}/mcp`]);
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
  R5a: async () => {
    // S pinned to none: refused with its id, and S's own server does not send the retry without the optional
    // session_id to the default A. (A server that never named a session still does: R3.)
    const { root } = nullPinned();
    assert.equal(pinnedConnection(root, 'S'), null);
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    assert.equal((await proxy.handle(remember(1, 'S'))).result.isError, true);
    assert.equal((await proxy.handle(remember(2, null))).result.isError, true);
    assert.deepEqual(sent(node), []);
    // Positive control: once S chooses a connection, a call without an id reaches the default again.
    useConnection(root, H('a'), { sessionId: 'S' });
    await proxy.handle(remember(3, null));
    assert.deepEqual(sent(node), [`${N('a')}/mcp`]);
  },
  R5b: () => {
    // A transcript noted on A is distilled into A only while S still sends to A: never after a move, to B or to none.
    assert.deepEqual(distilOfS(() => {}), [[0, 3]], 'control: S still on A, A reads all of it');
    assert.deepEqual(distilOfS((root) => useConnection(root, H('b'), { sessionId: 'S' })), [], 'moved to B');
    assert.deepEqual(distilOfS((root) => {
      useConnection(root, H('b'), { sessionId: 'S' });
      removeConnection(root, H('b'));
    }), [], 'moved to B, B removed');
    assert.deepEqual(distilOfS((root) => useConnection(root, H('a'), { sessionId: 'S' })), [[0, 3]], 'moved to A itself');
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
  noIdRule: async () => {
    // On a server that has named no session, a call without one is refused only while a moved session sends to a
    // live connection other than the default.
    const root = home();
    saveConnection(root, grant('a'));
    saveConnection(root, grant('b'));
    useConnection(root, H('a'));
    const node = recordingNode();
    const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
    await proxy.handle(req(0, 'tools/list'));
    useConnection(root, H('a'), { sessionId: 'toA' }); // moved to the default: nothing to tell apart
    assert.notEqual((await proxy.handle(remember(1, null))).result.isError, true);
    useConnection(root, H('b'), { sessionId: 'toB' });
    assert.equal((await proxy.handle(remember(2, null))).result.isError, true);
    removeConnection(root, H('b'));
    assert.notEqual((await proxy.handle(remember(3, null))).result.isError, true, 'toB now sends to none');
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('a')}/mcp`]);
    // The same server once told it serves toB: a call without an id is toB's, pinned to none, and refused.
    assert.equal((await proxy.handle(remember(4, 'toB'))).result.isError, true);
    assert.equal((await proxy.handle(remember(5, null))).result.isError, true);
    assert.deepEqual(sent(node), [`${N('a')}/mcp`, `${N('a')}/mcp`]);
  },
  fuzz: async () => {
    // Random connects, defaults, moves, removes and opens: an open session naming itself is never locked out while
    // it has a connection, and neither its hooks nor its tools ever reach another node than its own.
    const locked = [];
    const crossed = [];
    for (let seed = 1; seed <= 60; seed++) {
      let st = seed >>> 0;
      const r = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const root = home();
      const log = [];
      const open = [];
      for (let step = 0; step < 14; step++) {
        const names = connectionNames(root);
        const c = 'abc'[Math.floor(r() * 3)];
        const op = Math.floor(r() * 6);
        try {
          if (op === 0) { saveConnection(root, grant(c)); log.push(`connect ${c}`); }
          else if (op === 1 && names.includes(H(c))) { useConnection(root, H(c)); log.push(`use ${c}`); }
          else if (op === 2 && names.includes(H(c)) && open.length) {
            const t = open[Math.floor(r() * open.length)];
            useConnection(root, H(c), { sessionId: t.sid });
            t.want = N(c);
            log.push(`use ${c} --session ${t.sid}`);
          } else if (op === 3 && names.includes(H(c))) { removeConnection(root, H(c)); log.push(`remove ${c}`); }
          else if (op >= 4) {
            const sid = `t${open.length}`;
            const s = startSession(root, sid);
            const node = recordingNode();
            const proxy = createProxy({ root, env: {}, fetchImpl: node.fetchImpl });
            await proxy.handle(req(0, 'tools/list'));
            assert.match(s.note ?? '', new RegExp(`${sid}\\b`), `note without id: ${s.note}`);
            open.push({ sid, proxy, node, want: s.key ? `https://${s.key}` : undefined });
            log.push(`open ${sid}`);
          }
        } catch (e) {
          if (e.code === 'ERR_ASSERTION') throw e;
          log.push(`(${e.message})`);
        }
        for (const t of open) {
          const k = hookNode(root, t.sid);
          if (k && t.want === undefined) t.want = `https://${k}`;
          if (k && `https://${k}` !== t.want) crossed.push(`seed ${seed} ${t.sid} hook -> ${k}: ${log.join('; ')}`);
          if (!k) continue;
          const before = sent(t.node).length;
          await t.proxy.handle(remember(2, t.sid));
          const got = sent(t.node).slice(before);
          for (const g of got) if (g !== `${t.want}/mcp`) crossed.push(`seed ${seed} ${t.sid} tool -> ${g}: ${log.join('; ')}`);
          if (!got.length) locked.push(`seed ${seed} ${t.sid}: ${log.join('; ')}`);
        }
      }
    }
    assert.deepEqual({ locked: locked.slice(0, 3), crossed: crossed.slice(0, 3) }, { locked: [], crossed: [] });
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
