import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  NODE_ENV, connectionKey, connectionPaths, migrateLegacy, listConnections, defaultConnection,
  findConnection, saveConnection, useConnection, removeConnection, resolveSession, sessionPaths,
} from '../lib/connections.js';
import { loadCredentials } from '../lib/home.js';

const TOKEN_A = ['wat_', 'a1Aa2Bb3Cc4Dd5Ee6Ff7Gg8Hh9Ii0Jj'].join('');
const TOKEN_B = ['wat_', 'b1Kk2Ll3Mm4Nn5Oo6Pp7Qq8Rr9Ss0Tt'].join('');

const home = () => mkdtempSync(join(tmpdir(), 'wybe-connect-conns-'));
const creds = (nodeUrl, accessToken, scopes = ['remember', 'sessions:light']) => ({
  nodeUrl, mcpEndpoint: `${nodeUrl}/mcp`, tokenEndpoint: 'https://auth.example.test/oauth/token', clientId: 'c1',
  accessToken, refreshToken: null, scopes, connectedAt: '2026-10-22T08:00:00.000Z',
});

test('connectionKey: the node host, lowercased, port kept filename-safe', () => {
  assert.equal(connectionKey('https://Dittfirma.wybe.me/'), 'dittfirma.wybe.me');
  assert.equal(connectionKey('https://andrefirma.wybe.me/mcp'), 'andrefirma.wybe.me');
  assert.equal(connectionKey('http://127.0.0.1:8443'), '127.0.0.1_8443');
});

test('saveConnection: a second node does not overwrite the first; the newest is the default', () => {
  const root = home();
  assert.equal(saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A)), 'dittfirma.wybe.me');
  assert.equal(saveConnection(root, creds('https://andrefirma.wybe.me', TOKEN_B)), 'andrefirma.wybe.me');
  assert.equal(loadCredentials(connectionPaths(root, 'dittfirma.wybe.me')).accessToken, TOKEN_A);
  assert.equal(loadCredentials(connectionPaths(root, 'andrefirma.wybe.me')).accessToken, TOKEN_B);
  assert.equal(defaultConnection(root), 'andrefirma.wybe.me');
  const list = listConnections(root);
  assert.deepEqual(list.map((c) => [c.key, c.isDefault]), [['andrefirma.wybe.me', true], ['dittfirma.wybe.me', false]]);
  assert.deepEqual(list[1].scopes, ['remember', 'sessions:light']);
  assert.ok(!JSON.stringify(list).includes('wat_'), 'a listing never carries a token');
});

test('saveConnection: --name keeps a second account on the same node apart; a bad name is refused', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  assert.equal(saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_B), { name: 'Ditt-Andre' }), 'ditt-andre');
  assert.equal(listConnections(root).length, 2);
  assert.throws(() => saveConnection(root, creds('https://x.wybe.me', TOKEN_A), { name: '../escape' }), /connection name/);
  assert.throws(() => saveConnection(root, creds('https://x.wybe.me', TOKEN_A), { name: '' }), /connection name/);
});

test('migrateLegacy: one old credentials.json, its queue and its question caches move under the node, nothing lost; idempotent', () => {
  const root = home();
  const legacy = JSON.stringify({ version: 1, ...creds('https://dittfirma.wybe.me', TOKEN_A) });
  writeFileSync(join(root, 'credentials.json'), legacy);
  mkdirSync(join(root, 'queue'));
  writeFileSync(join(root, 'queue', '000000000000001-0-aa.json'), '{"payload":1}');
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'open-questions.json'), '{"open_questions":[]}');
  writeFileSync(join(root, 'state', 'surfaced-questions.json'), '{"q-1":"2026-10-01T00:00:00.000Z"}');
  writeFileSync(join(root, 'state', 'some-transcript.json'), '{"byteOffset":10,"seq":1}');

  assert.equal(migrateLegacy(root), 'dittfirma.wybe.me');
  const p = connectionPaths(root, 'dittfirma.wybe.me');
  assert.equal(readFileSync(p.credentials, 'utf8'), legacy, 'the grant moves byte for byte');
  assert.equal(existsSync(join(root, 'credentials.json')), false);
  assert.deepEqual(readdirSync(p.queue), ['000000000000001-0-aa.json']);
  assert.equal(readFileSync(p.openQuestions, 'utf8'), '{"open_questions":[]}');
  assert.equal(readFileSync(p.surfacedQuestions, 'utf8'), '{"q-1":"2026-10-01T00:00:00.000Z"}');
  assert.ok(existsSync(join(root, 'state', 'some-transcript.json')), 'transcript cursors stay shared');
  assert.equal(defaultConnection(root), 'dittfirma.wybe.me');

  assert.equal(migrateLegacy(root), null, 'nothing left to migrate');
  assert.equal(loadCredentials(p).accessToken, TOKEN_A);
});

test('migrateLegacy: when the node already has a connection, the old file is left untouched rather than overwrite either', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_B));
  const legacy = JSON.stringify({ version: 1, ...creds('https://dittfirma.wybe.me', TOKEN_A) });
  writeFileSync(join(root, 'credentials.json'), legacy);
  assert.equal(migrateLegacy(root), null);
  assert.equal(readFileSync(join(root, 'credentials.json'), 'utf8'), legacy);
  assert.equal(loadCredentials(connectionPaths(root, 'dittfirma.wybe.me')).accessToken, TOKEN_B);
});

test('findConnection: by name, by URL or bare host; unknown is null', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  assert.equal(findConnection(root, 'dittfirma.wybe.me'), 'dittfirma.wybe.me');
  assert.equal(findConnection(root, 'https://DITTFIRMA.wybe.me/'), 'dittfirma.wybe.me');
  assert.equal(findConnection(root, 'nope.wybe.me'), null);
  assert.equal(findConnection(root, ''), null);
});

test('resolveSession: the only one; else the last used; a session keeps its connection when the default moves', () => {
  const root = home();
  assert.equal(resolveSession(root, { sessionId: 's0', env: {} }), null, 'nothing connected');
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  assert.equal(resolveSession(root, { sessionId: 's1', env: {} }), 'dittfirma.wybe.me', 'the only one');
  saveConnection(root, creds('https://andrefirma.wybe.me', TOKEN_B));
  assert.equal(resolveSession(root, { sessionId: 's2', env: {} }), 'andrefirma.wybe.me', 'the last connected');
  assert.equal(resolveSession(root, { sessionId: 's1', env: {} }), 'dittfirma.wybe.me', 's1 stays where it started');
  useConnection(root, 'dittfirma.wybe.me');
  assert.equal(resolveSession(root, { sessionId: 's3', env: {} }), 'dittfirma.wybe.me', 'use moves the default');
  assert.equal(resolveSession(root, { sessionId: 's2', env: {} }), 'andrefirma.wybe.me', 's2 stays too');
  assert.equal(resolveSession(root, { env: {} }), 'dittfirma.wybe.me', 'no session id: the default');
});

test('resolveSession: WYBE_CONNECT_NODE picks for a new session; an unknown choice never falls back to another node', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  saveConnection(root, creds('https://andrefirma.wybe.me', TOKEN_B));
  assert.equal(resolveSession(root, { sessionId: 'e1', env: { [NODE_ENV]: 'dittfirma.wybe.me' } }), 'dittfirma.wybe.me');
  assert.equal(resolveSession(root, { sessionId: 'e1', env: {} }), 'dittfirma.wybe.me', 'the choice sticks to the session');
  assert.equal(resolveSession(root, { sessionId: 'e2', env: { [NODE_ENV]: 'https://dittfirma.wybe.me' } }), 'dittfirma.wybe.me');
  assert.equal(resolveSession(root, { sessionId: 'e3', env: { [NODE_ENV]: 'typo.wybe.me' } }), null);
  assert.equal(resolveSession(root, { sessionId: 'e3', env: {} }), 'andrefirma.wybe.me', 'an unknown choice pins nothing');
});

test('useConnection --session: switches one session only; unknown is refused', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  saveConnection(root, creds('https://andrefirma.wybe.me', TOKEN_B));
  assert.equal(resolveSession(root, { sessionId: 'u1', env: {} }), 'andrefirma.wybe.me');
  assert.equal(useConnection(root, 'dittfirma.wybe.me', { sessionId: 'u1' }), 'dittfirma.wybe.me');
  assert.equal(resolveSession(root, { sessionId: 'u1', env: {} }), 'dittfirma.wybe.me');
  assert.equal(resolveSession(root, { sessionId: 'u2', env: {} }), 'andrefirma.wybe.me', 'the default did not move');
  assert.throws(() => useConnection(root, 'nope.wybe.me'), /no connection named nope\.wybe\.me/);
});

test('removeConnection: deletes the grant and its queue, the default falls to the next most recent, pinned sessions go quiet', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  saveConnection(root, creds('https://andrefirma.wybe.me', TOKEN_B));
  const p = connectionPaths(root, 'andrefirma.wybe.me');
  mkdirSync(p.queue, { recursive: true });
  writeFileSync(join(p.queue, '000000000000001-0-aa.json'), '{}');
  assert.equal(resolveSession(root, { sessionId: 'r1', env: {} }), 'andrefirma.wybe.me');
  assert.deepEqual(removeConnection(root, 'https://andrefirma.wybe.me'), { key: 'andrefirma.wybe.me', dropped: 1 });
  assert.equal(existsSync(join(root, 'connections', 'andrefirma.wybe.me')), false);
  assert.equal(defaultConnection(root), 'dittfirma.wybe.me');
  assert.equal(resolveSession(root, { sessionId: 'r1', env: {} }), null, 'never moves a session to another node by itself');
  assert.equal(resolveSession(root, { sessionId: 'r2', env: {} }), 'dittfirma.wybe.me');
  assert.throws(() => removeConnection(root, 'andrefirma.wybe.me'), /no connection named/);
});

test('sessionPaths: credentials, queue and question caches per connection; cursors and spool shared; none when not connected', () => {
  const root = home();
  const none = sessionPaths(root, { sessionId: 'p0', env: {} });
  assert.equal(none.connection, null);
  assert.equal(loadCredentials(none), null);
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  saveConnection(root, creds('https://andrefirma.wybe.me', TOKEN_B));
  const a = sessionPaths(root, { sessionId: 'p1', env: { [NODE_ENV]: 'dittfirma.wybe.me' } });
  const b = sessionPaths(root, { sessionId: 'p2', env: {} });
  assert.equal(loadCredentials(a).accessToken, TOKEN_A);
  assert.equal(loadCredentials(b).accessToken, TOKEN_B);
  assert.notEqual(a.queue, b.queue);
  assert.notEqual(a.openQuestions, b.openQuestions);
  assert.equal(a.cursor('t'), b.cursor('t'));
  assert.equal(a.spool, b.spool);
});
