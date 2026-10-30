// send_file carries a whole file as one base64 string (contentBase64). Redacted as one value, the
// high-entropy family took the whole blob for a credential and replaced it with a tag, so the node
// refused every file as invalid base64. The proxy now redacts the FILE: a text file is decoded,
// redacted like pasted text and re-encoded; a binary file (PDF, image, office zip) goes unchanged.
// Every other tool and every other argument keeps the ordinary redaction. The node is an
// in-process fake fetch; the secrets are fabricated and assembled from parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createProxy } from '../lib/mcp-proxy.js';
import { paths, saveCredentials } from '../lib/home.js';

const j = (...p) => p.join('');
const tag = (family) => j('[RED', 'ACTED:', family, ']');
const PW = j('pass', 'word');
const PASSWORD = j('hunter', '2abc');
const AWS_KEY = j('AKIA', 'FAKEFAKE', '0FAKE0FA');
const STRIPE = j('sk', '_live_', 'FAKE0fake0FAKE0fake0FAKE0');
/** 48 characters of mixed case and digits with few vowels: what the high-entropy family takes. */
const RANDOM = j('Xk9QzR7mWp2Lf', 'Tq8VbN3sHd6Jc', 'Y4gZw1Bx5Ct7Rn', 'K2PmQv');

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
  const p = paths(mkdtempSync(join(tmpdir(), 'wybe-connect-send-file-')));
  saveCredentials({ nodeUrl: 'https://demo.example.test', resource: 'https://demo.example.test/mcp', mcpEndpoint: 'https://demo.example.test/mcp', issuer: 'https://auth.example.test', tokenEndpoint: 'https://auth.example.test/t', clientId: 'c1', accessToken: ['wat', 'x'.repeat(40)].join('_'), refreshToken: null, expiresAt: null, scopes: ['remember'] }, p);
  return p;
}

/** Sends one tools/call through the proxy and returns the arguments the node received. */
async function forwarded(name, args) {
  const node = fakeNode();
  const proxy = createProxy({ paths: connectedHome(), fetchImpl: node.fetchImpl });
  const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.result?.isError, undefined, `the call was forwarded: ${JSON.stringify(r)}`);
  assert.equal(node.seen.length, 1, 'the fake node saw the call');
  assert.equal(node.seen[0].name, name);
  return node.seen[0].arguments;
}

/** Deterministic bytes that are not text (every byte value occurs). */
function noise(n, seed) {
  const out = [];
  let h = Buffer.from(seed);
  while (out.length < n) {
    h = createHash('sha256').update(h).digest();
    out.push(...h);
  }
  return Buffer.from(out.slice(0, n));
}

const b64 = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), noise(600, 'png')]);
// An ASCII-only PDF: valid UTF-8 without NULs, so only its type (and its %PDF- magic) says binary.
const PDF = Buffer.from(['%PDF-1.4', '1 0 obj << /Type /Catalog >> endobj', `% ${RANDOM}`, 'trailer << /Root 1 0 R >>', '%%EOF', ''].join('\n'));

test('send_file: a plain text file reaches the node byte-identical (red before: the whole contentBase64 became the high-entropy tag)', async () => {
  const content = 'SGVpIFNpZ3JpZCwgZGV0dGUgZXIgZW4gdGVzdGZpbCBmcmEgQ2xhdWRlIENvZGUuIEtvZGVvcmRldCBlciBibMOlYmFlci4K';
  const args = await forwarded('send_file', { filename: 'hei.txt', mimeType: 'text/plain', contentBase64: content });
  assert.deepEqual(args, { filename: 'hei.txt', mimeType: 'text/plain', contentBase64: content });
});

test('send_file: secrets inside a text file are redacted the way pasted text is, and the file is re-encoded as base64', async () => {
  const text = [
    '# deploy notes',
    `${PW} = ${PASSWORD}`,
    `aws_access_key_id = ${AWS_KEY}`,
    `STRIPE=${STRIPE}`,
    `random ${RANDOM} here`,
    'Kodeordet er blåbær, men det er ikke en hemmelighet.',
    '',
  ].join('\n');
  for (const mimeType of ['text/plain', 'text/markdown', 'application/octet-stream', 'application/x-yaml']) {
    const args = await forwarded('send_file', { filename: 'deploy.md', mimeType, contentBase64: b64(text), note: 'deploy' });
    assert.match(args.contentBase64, /^[A-Za-z0-9+/]*={0,2}$/, `${mimeType}: still base64`);
    const back = Buffer.from(args.contentBase64, 'base64').toString('utf8');
    for (const s of [PASSWORD, AWS_KEY, STRIPE, RANDOM]) assert.ok(!back.includes(s), `${mimeType}: a secret reached the node`);
    assert.ok(back.startsWith(`# deploy notes\n${PW} = ${tag('keyed-secret')}\n`), `${mimeType}: ${back}`);
    assert.ok(back.includes(tag('aws-access-key')), mimeType);
    assert.ok(back.includes(`random ${tag('high-entropy')} here`), mimeType);
    assert.ok(back.endsWith('Kodeordet er blåbær, men det er ikke en hemmelighet.\n'), `${mimeType}: the rest of the text is kept`);
    assert.equal(args.filename, 'deploy.md');
    assert.equal(args.note, 'deploy');
  }
});

test('send_file: a text file that is not UTF-8 (latin1) keeps every byte except the secret', async () => {
  const before = Buffer.from(`navn = Bjørn\n${PW} = ${PASSWORD}\nslutt\n`, 'latin1');
  const args = await forwarded('send_file', { filename: 'gammel.txt', mimeType: 'text/plain; charset=iso-8859-1', contentBase64: before.toString('base64') });
  const back = Buffer.from(args.contentBase64, 'base64');
  assert.ok(back.equals(Buffer.from(`navn = Bjørn\n${PW} = ${tag('keyed-secret')}\nslutt\n`, 'latin1')), back.toString('latin1'));
});

test('send_file: binary files (PNG, PDF, office zip, unknown bytes) pass through byte-identical, never replaced by the high-entropy tag', async () => {
  const DOCX = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), noise(400, 'docx')]);
  const cases = [
    ['bilde.png', 'image/png', PNG],
    ['avtale.pdf', 'application/pdf', PDF],
    // Mislabelled: the %PDF- magic still says binary, so an ASCII PDF is never rewritten as text.
    ['avtale.pdf', 'application/octet-stream', PDF],
    ['notat.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', DOCX],
    ['data.bin', 'application/octet-stream', noise(300, 'bin')],
  ];
  for (const [filename, mimeType, bytes] of cases) {
    const content = bytes.toString('base64');
    const args = await forwarded('send_file', { filename, mimeType, contentBase64: content, note: 'se vedlegg' });
    assert.equal(args.contentBase64, content, `${filename} (${mimeType}) changed on the way`);
    assert.deepEqual({ ...args, contentBase64: undefined }, { filename, mimeType, contentBase64: undefined, note: 'se vedlegg' });
  }
});

test('send_file: filename and note keep the ordinary redaction', async () => {
  const args = await forwarded('send_file', { filename: 'hei.txt', mimeType: 'text/plain', contentBase64: b64('hei\n'), note: `${PW}=${PASSWORD} and ${RANDOM}` });
  assert.equal(args.note, `${PW}=${tag('keyed-secret')} and ${tag('high-entropy')}`);
  assert.equal(args.contentBase64, b64('hei\n'));
});

test('send_file: a contentBase64 that is not base64 gets the ordinary redaction (the node refuses it either way)', async () => {
  const args = await forwarded('send_file', { filename: 'x.txt', mimeType: 'text/plain', contentBase64: `not base64! ${PW}=${PASSWORD}` });
  assert.equal(args.contentBase64, `not base64! ${PW}=${tag('keyed-secret')}`);
});

test('every other tool: a high-entropy argument is still redacted, contentBase64 included', async () => {
  const args = await forwarded('remember', { items: [{ subject: 'deploy', text: `token ${RANDOM}` }], contentBase64: PNG.toString('base64') });
  assert.equal(args.items[0].text, `token ${tag('high-entropy')}`);
  assert.equal(args.contentBase64, tag('high-entropy'), 'only send_file gets the file treatment');
});
