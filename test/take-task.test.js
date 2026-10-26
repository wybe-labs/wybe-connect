// take_task in the plugin's MCP server: a confirm task's text reaches the session only through
// it. With the client's elicitation capability the person decides in a form (Godta / Avvis);
// without it, the text comes back with the instruction to ask the person and wait for a yes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createProxy, runStdio, TAKE_TASK_TOOL } from '../lib/mcp-proxy.js';
import { connectionPaths } from '../lib/connections.js';
import { saveCredentials } from '../lib/home.js';
import { pollOnce, findTask } from '../lib/bridge.js';
import { startFakeNode, grantFor } from './fixtures/fake-node.mjs';

const SID = 'sess-take-0001';
const req = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const textOf = (r) => r.result.content[0].text;

async function withOffered(node, mode = 'confirm', text = 'Rydd opp i gamle grener og push til main') {
  const root = mkdtempSync(join(tmpdir(), 'wybe-connect-take-'));
  const p = connectionPaths(root, 'node-a');
  saveCredentials(grantFor(node), p);
  const t = { id: randomUUID(), text, mode, session_id: SID };
  node.tasks.push(t);
  await pollOnce(p, SID);
  return { p, t };
}

async function initialized(proxy, elicitation) {
  await proxy.handle(req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: elicitation ? { elicitation: {} } : {} }));
}

test('take_task is listed once connected, with the node\'s tools and connect', async () => {
  const node = await startFakeNode();
  try {
    const { p } = await withOffered(node);
    const proxy = createProxy({ paths: p });
    const names = (await proxy.handle(req(2, 'tools/list'))).result.tools.map((t) => t.name);
    assert.deepEqual(names, ['take_task', 'connect']);
    assert.deepEqual(TAKE_TASK_TOOL.inputSchema.required, ['task_id']);
  } finally {
    await node.close();
  }
});

test('elicitation, Godta: the form shows the exact text; take_task returns it and the task is running', async () => {
  const node = await startFakeNode();
  try {
    const { p, t } = await withOffered(node);
    const asked = [];
    const proxy = createProxy({ paths: p, request: async (method, params) => { asked.push({ method, params }); return { action: 'accept', content: {} }; } });
    await initialized(proxy, true);
    const r = await proxy.handle(req(2, 'tools/call', { name: 'take_task', arguments: { task_id: t.id } }));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].method, 'elicitation/create');
    assert.ok(asked[0].params.message.includes(t.text), 'the exact task text in the form');
    assert.match(asked[0].params.message, /Godta/);
    assert.match(asked[0].params.message, /Avvis/);
    assert.deepEqual(asked[0].params.requestedSchema, { type: 'object', properties: {} });
    assert.ok(textOf(r).includes(t.text));
    assert.match(textOf(r), /accepted/);
    assert.equal(findTask(p, t.id).task.status, 'running');
    assert.equal(node.tool('task_result').length, 0);
  } finally {
    await node.close();
  }
});

for (const action of ['decline', 'cancel']) {
  test(`elicitation, ${action}: task_result refused is sent, and the text is not handed to the session`, async () => {
    const node = await startFakeNode();
    try {
      const { p, t } = await withOffered(node);
      const proxy = createProxy({ paths: p, request: async () => ({ action }) });
      await initialized(proxy, true);
      const r = await proxy.handle(req(2, 'tools/call', { name: 'take_task', arguments: { task_id: t.id } }));
      assert.ok(!textOf(r).includes(t.text));
      assert.match(textOf(r), /declined/);
      assert.deepEqual(node.tool('task_result').map((c) => [c.args.task_id, c.args.session_id, c.args.status]), [[t.id, SID, 'refused']]);
      assert.equal(findTask(p, t.id).task.status, 'reported');
    } finally {
      await node.close();
    }
  });
}

test('elicitation present: accepted: true from the model does not skip the form', async () => {
  const node = await startFakeNode();
  try {
    const { p, t } = await withOffered(node);
    let asked = 0;
    const proxy = createProxy({ paths: p, request: async () => { asked += 1; return { action: 'decline' }; } });
    await initialized(proxy, true);
    await proxy.handle(req(2, 'tools/call', { name: 'take_task', arguments: { task_id: t.id, accepted: true } }));
    assert.equal(asked, 1);
    assert.equal(node.tool('task_result')[0].args.status, 'refused');
  } finally {
    await node.close();
  }
});

test('no elicitation: the text comes back to be shown verbatim with a wait-for-yes instruction; accepted true runs it, false refuses', async () => {
  const node = await startFakeNode();
  try {
    const { p, t } = await withOffered(node);
    const proxy = createProxy({ paths: p, request: async () => { throw new Error('must not ask a client without elicitation'); } });
    await initialized(proxy, false);
    const first = await proxy.handle(req(2, 'tools/call', { name: 'take_task', arguments: { task_id: t.id } }));
    assert.ok(textOf(first).includes(t.text));
    assert.match(textOf(first), /word for word/);
    assert.match(textOf(first), /explicit yes/);
    assert.equal(findTask(p, t.id).task.status, 'offered', 'nothing runs before the yes');
    const yes = await proxy.handle(req(3, 'tools/call', { name: 'take_task', arguments: { task_id: t.id, accepted: true } }));
    assert.ok(textOf(yes).includes(t.text));
    assert.equal(findTask(p, t.id).task.status, 'running');

    const second = { id: randomUUID(), text: 'Noe personen sier nei til', mode: 'confirm', session_id: SID };
    node.tasks.push(second);
    await pollOnce(p, SID);
    const no = await proxy.handle(req(4, 'tools/call', { name: 'take_task', arguments: { task_id: second.id, accepted: false } }));
    assert.match(textOf(no), /declined/);
    assert.equal(node.tool('task_result')[0].args.status, 'refused');
  } finally {
    await node.close();
  }
});

test('take_task: an unknown id, a settled task, or no connection is an error', async () => {
  const node = await startFakeNode();
  try {
    const { p, t } = await withOffered(node);
    const proxy = createProxy({ paths: p, request: async () => ({ action: 'decline' }) });
    await initialized(proxy, true);
    assert.equal((await proxy.handle(req(2, 'tools/call', { name: 'take_task', arguments: { task_id: randomUUID() } }))).result.isError, true);
    await proxy.handle(req(3, 'tools/call', { name: 'take_task', arguments: { task_id: t.id } }));
    assert.equal((await proxy.handle(req(4, 'tools/call', { name: 'take_task', arguments: { task_id: t.id } }))).result.isError, true);
    const none = createProxy({ paths: connectionPaths(mkdtempSync(join(tmpdir(), 'wybe-connect-take-')), 'x') });
    assert.equal((await none.handle(req(5, 'tools/call', { name: 'take_task', arguments: { task_id: t.id } }))).result.isError, true);
  } finally {
    await node.close();
  }
});

test('stdio: the server sends elicitation/create as its own request and resumes when the client answers', async () => {
  const node = await startFakeNode();
  try {
    const { p, t } = await withOffered(node);
    const input = new PassThrough();
    const output = new PassThrough();
    const out = [];
    let buf = '';
    output.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    });
    runStdio({ paths: p, input, output });
    const until = async (fn) => { for (let i = 0; i < 200; i++) { const x = fn(); if (x) return x; await new Promise((r) => setTimeout(r, 20)); } return null; };
    input.write(`${JSON.stringify(req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } }))}\n`);
    input.write(`${JSON.stringify(req(2, 'tools/call', { name: 'take_task', arguments: { task_id: t.id } }))}\n`);
    const ask = await until(() => out.find((m) => m.method === 'elicitation/create'));
    assert.ok(ask, 'an elicitation request went out');
    assert.ok(ask.id !== undefined && ask.id !== 1 && ask.id !== 2, 'with an id of its own');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: ask.id, result: { action: 'accept', content: {} } })}\n`);
    const answer = await until(() => out.find((m) => m.id === 2));
    assert.ok(answer.result.content[0].text.includes(t.text));
    assert.ok(!out.some((m) => m.error && m.id === ask.id), 'the client\'s answer is not treated as a request');
    input.end();
  } finally {
    await node.close();
  }
});
