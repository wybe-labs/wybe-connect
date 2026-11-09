// Every tools/call argument the proxy forwards to the node passes through redactValue first. Without it the redaction families protect nothing on the MCP path. The node is
// an in-process fake fetch; the secrets are fabricated and assembled from parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy } from '../lib/mcp-proxy.js';
import { paths, saveCredentials } from '../lib/home.js';
import { redact } from '../lib/redact.js';

const j = (...p) => p.join('');
const JWT = [j('eyJhbGciOiJI', 'UzI1NiJ9'), j('eyJzdWIiOiJkZW1v', 'LXVzZXIifQ'), j('c2lnbmF0dXJl', 'LXBhcnQtZmFrZQ')].join('.');
/** [input, the secret text that must not reach the node] */
const SECRETS = {
  password: [j('pass', 'word=', 'FakePw2026'), 'FakePw2026'],
  jwt: [j('Authorization: Bearer ', JWT), JWT],
  stripe: [j('sk', '_live_', 'FAKE0fake0FAKE0fake0FAKE0'), 'FAKE0fake0FAKE0fake0FAKE0'],
  pem: [j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvFAKEfakeFAKEfake\n-----END ', 'PRIVATE KEY-----'), 'MIIEvFAKEfakeFAKEfake'],
};

function fakeNode() {
  const seen = [];
  const json = (o, h = {}) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', ...h } });
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    seen.push(msg.params);
    return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  };
  return { seen, fetchImpl };
}

function connectedHome() {
  const p = paths(mkdtempSync(join(tmpdir(), 'wybe-connect-proxy-redact-')));
  saveCredentials({ nodeUrl: 'https://demo.example.test', resource: 'https://demo.example.test/mcp', mcpEndpoint: 'https://demo.example.test/mcp', issuer: 'https://auth.example.test', tokenEndpoint: 'https://auth.example.test/t', clientId: 'c1', accessToken: ['wat', 'x'.repeat(40)].join('_'), refreshToken: null, expiresAt: null, scopes: ['remember'] }, p);
  return p;
}

test('a secret in a tools/call argument never reaches the node; the rest of the call is forwarded as it was', async () => {
  assert.deepEqual(Object.entries(SECRETS).filter(([, [i, s]]) => redact(i).text.includes(s)).map(([k]) => k), [], 'control: redact() catches each one');
  const node = fakeNode();
  const proxy = createProxy({ paths: connectedHome(), fetchImpl: node.fetchImpl });
  const items = Object.entries(SECRETS).map(([k, [i]]) => ({ subject: k, text: `Deploy note: ${i}` }));
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember', arguments: { items, answers: ['q-1'] } } });
  assert.equal(node.seen.length, 1, 'the fake node saw the call');
  const forwarded = JSON.stringify(node.seen[0]);
  assert.deepEqual(Object.entries(SECRETS).filter(([, [, s]]) => forwarded.includes(s)).map(([k]) => k), [], 'secrets reached the node');
  const sent = node.seen[0];
  assert.equal(sent.name, 'remember');
  assert.deepEqual(sent.arguments.answers, ['q-1']);
  assert.deepEqual(sent.arguments.items.map((x) => x.subject), Object.keys(SECRETS));
  assert.ok(sent.arguments.items.every((x) => x.text.startsWith('Deploy note: ')));
});

test('an argument the redactor cannot walk is refused, never forwarded', async () => {
  const node = fakeNode();
  const proxy = createProxy({ paths: connectedHome(), fetchImpl: node.fetchImpl });
  // JSON-RPC carries only JSON, so this stands for a value a future caller might pass in-process.
  const r = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: { items: [{ text: 'x', at: new Date(0) }] } } });
  assert.equal(node.seen.length, 0, 'nothing was forwarded');
  assert.equal(r.result?.isError, true);
});
