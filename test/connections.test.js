import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  NODE_ENV, connectionKey, connectionPaths, migrateLegacy, listConnections, defaultConnection,
  findConnection, saveConnection, checkSave, useConnection, removeConnection, resolveSession, sessionPaths, accountKey,
} from '../lib/connections.js';
import { loadCredentials } from '../lib/home.js';
import { createDelivery, newSummary } from '../lib/flush.js';
import { enqueue } from '../lib/queue.js';

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
  assert.equal(resolveSession(root, { sessionId: 'e3', env: {} }), null, 'and the session stays unconnected, not on the default');
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

test('saveConnection: a name already held by another node is refused, so its grant and queue never pass to that node', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  assert.throws(() => saveConnection(root, creds('https://andrefirma.wybe.me', TOKEN_B), { name: 'dittfirma.wybe.me' }), /dittfirma\.wybe\.me is https:\/\/dittfirma\.wybe\.me; remove it first or choose another --name/);
  assert.throws(() => checkSave(root, 'https://andrefirma.wybe.me', 'dittfirma.wybe.me'), /remove it first/, 'the CLI can refuse before the browser opens');
  assert.equal(loadCredentials(connectionPaths(root, 'dittfirma.wybe.me')).accessToken, TOKEN_A);
  assert.equal(saveConnection(root, creds('https://dittfirma.wybe.me/', TOKEN_B)), 'dittfirma.wybe.me', 'the same node again replaces its own grant');
  assert.equal(loadCredentials(connectionPaths(root, 'dittfirma.wybe.me')).accessToken, TOKEN_B);
});

test('connectionKey: IPv6, very long hosts and a trailing dot still give a findable name', () => {
  for (const url of ['http://[::1]:8443', `https://${'a'.repeat(63)}.example.com`, `https://${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.example.com`, 'https://dittfirma.wybe.me.']) {
    const root = home();
    const key = saveConnection(root, creds(url, TOKEN_A));
    assert.deepEqual(listConnections(root).map((c) => c.key), [key], url);
    assert.equal(findConnection(root, url), key, url);
    assert.ok(key.length <= 120, url);
  }
  assert.equal(connectionKey('https://dittfirma.wybe.me.'), 'dittfirma.wybe.me');
  assert.throws(() => saveConnection(home(), creds('https://x.wybe.me', TOKEN_A), { name: 'foo.' }), /connection name/, 'Windows drops a trailing dot');
});

test('migrateLegacy: an unreadable old credentials.json is set aside, not lost, and blocks nothing', () => {
  const root = home();
  writeFileSync(join(root, 'credentials.json'), '{"version":2,"nope":1}');
  assert.doesNotThrow(() => saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A)));
  assert.equal(existsSync(join(root, 'credentials.json')), false);
  assert.equal(readFileSync(join(root, 'credentials.unreadable.json'), 'utf8'), '{"version":2,"nope":1}');
  assert.equal(listConnections(root).length, 1);
  writeFileSync(join(root, 'credentials.json'), 'not json');
  assert.equal(listConnections(root).length, 1);
  assert.equal(readdirSync(root).filter((f) => f.startsWith('credentials.unreadable')).length, 2, 'a second one does not overwrite the first');
});

test('migrateLegacy: killed at any step, the next call finishes it with nothing stranded', () => {
  for (let crashAt = 1; crashAt <= 5; crashAt++) {
    const root = home();
    writeFileSync(join(root, 'credentials.json'), JSON.stringify({ version: 1, ...creds('https://dittfirma.wybe.me', TOKEN_A) }));
    mkdirSync(join(root, 'queue'));
    writeFileSync(join(root, 'queue', '000000000000001-0-aa.json'), '{"n":1}');
    writeFileSync(join(root, 'queue', '000000000000002-0-bb.json'), '{"n":2}');
    mkdirSync(join(root, 'state'));
    writeFileSync(join(root, 'state', 'open-questions.json'), '{"open_questions":[]}');
    const r = spawnSync(process.execPath, [join(import.meta.dirname, 'fixtures', 'crash-migrate.mjs')], { env: { ...process.env, CRASH_AT: String(crashAt), MIGRATE_ROOT: root }, encoding: 'utf8' });
    assert.ok(r.status === 9 || r.status === 0, `crash at ${crashAt}: ${r.stderr}`);
    const key = resolveSession(root, { env: {} });
    assert.equal(key, 'dittfirma.wybe.me', `crash at ${crashAt}`);
    const p = connectionPaths(root, key);
    assert.equal(loadCredentials(p).accessToken, TOKEN_A);
    assert.deepEqual(readdirSync(p.queue).sort(), ['000000000000001-0-aa.json', '000000000000002-0-bb.json'], `crash at ${crashAt}`);
    assert.ok(existsSync(p.openQuestions), `crash at ${crashAt}`);
    assert.equal(existsSync(join(root, 'credentials.json')), false);
    assert.deepEqual(existsSync(join(root, 'queue')) ? readdirSync(join(root, 'queue')) : [], [], `crash at ${crashAt}: old queue stranded`);
  }
});

test('a session pinned to one node goes quiet when its name is reused for another node', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A), { name: 'work' });
  saveConnection(root, creds('https://andrefirma.wybe.me', TOKEN_B));
  assert.equal(resolveSession(root, { sessionId: 'w1', env: { [NODE_ENV]: 'work' } }), 'work');
  removeConnection(root, 'work');
  saveConnection(root, creds('https://tredjefirma.wybe.me', TOKEN_B), { name: 'work' });
  assert.equal(resolveSession(root, { sessionId: 'w1', env: {} }), null);
  useConnection(root, 'work', { sessionId: 'w1' });
  assert.equal(resolveSession(root, { sessionId: 'w1', env: {} }), 'work', 'an explicit use re-pins it');
});

test('an unknown WYBE_CONNECT_NODE at a session\'s first hook keeps that session unconnected later too', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  assert.equal(resolveSession(root, { sessionId: 'x1', env: { [NODE_ENV]: 'typo' } }), null);
  assert.equal(resolveSession(root, { sessionId: 'x1', env: {} }), null);
  assert.equal(resolveSession(root, { sessionId: 'x2', env: {} }), 'dittfirma.wybe.me', 'a session without a choice still gets the default');
  useConnection(root, 'dittfirma.wybe.me', { sessionId: 'x1' });
  assert.equal(resolveSession(root, { sessionId: 'x1', env: {} }), 'dittfirma.wybe.me');
});

test('removing a connection while a flush refreshes its token does not bring it back', async () => {
  const root = home();
  saveConnection(root, { ...creds('https://dittfirma.wybe.me', TOKEN_A), refreshToken: 'wrt_x' });
  const p = connectionPaths(root, 'dittfirma.wybe.me');
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (calls === 1) {
      removeConnection(root, 'dittfirma.wybe.me');
      return new Response('', { status: 401 });
    }
    if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: TOKEN_B, token_type: 'Bearer', refresh_token: 'wrt_y', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { open_questions: [{ id: 'q', text: 't' }] } } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } });
  };
  const summary = newSummary('Stop');
  const d = createDelivery({ credentials: loadCredentials(p), paths: p, fetchImpl, summary });
  await d.deliver({ scope: 'sessions:light', prompts: [] });
  assert.equal(existsSync(join(root, 'connections', 'dittfirma.wybe.me')), false);

  const gone = await createDelivery({ credentials: { ...creds('https://dittfirma.wybe.me', TOKEN_A) }, paths: p, fetchImpl: async () => new Response('', { status: 503 }), summary: newSummary('Stop') });
  await gone.deliver({ scope: 'sessions:light', prompts: [] });
  assert.equal(existsSync(join(root, 'connections', 'dittfirma.wybe.me')), false, 'nothing is queued for a removed connection');
});

const mcpOk = (init) => {
  let id = 1;
  try { id = JSON.parse(String(init?.body)).id; } catch { /* not JSON */ }
  if (id === undefined) return new Response('', { status: 202 });
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: {} }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } });
};
const tokenOk = (access) => new Response(JSON.stringify({ access_token: access, token_type: 'Bearer', refresh_token: 'wrt_rotated', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });

test('a name removed and reconnected to another node during a flush: the new grant and its queue stay, the old node gets none of its items', async () => {
  const root = home();
  saveConnection(root, { ...creds('https://node-a.example.invalid', TOKEN_A), refreshToken: 'wrt_a' }, { name: 'work' });
  const p = connectionPaths(root, 'work');
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: String(init?.body ?? '') });
    if (seen.length === 1) {
      removeConnection(root, 'work');
      saveConnection(root, creds('https://node-b.example.invalid', TOKEN_B), { name: 'work' });
      enqueue(p.queue, { text: 'queued for node b' });
      return new Response('', { status: 401 });
    }
    if (String(url).endsWith('/oauth/token')) return tokenOk('wat_refreshed_for_a');
    return mcpOk(init);
  };
  const summary = newSummary('Stop');
  const d = createDelivery({ credentials: loadCredentials(p), paths: p, fetchImpl, summary });
  await d.deliver({ scope: 'sessions:light', prompts: [] });
  await d.drainQueue();
  const now = loadCredentials(p);
  assert.equal(now.nodeUrl, 'https://node-b.example.invalid');
  assert.equal(now.accessToken, TOKEN_B);
  assert.deepEqual(seen.filter((s) => s.body.includes('queued for node b')).map((s) => s.url), [], 'node a got an item queued for node b');
  assert.equal(seen.filter((s) => s.url.endsWith('/oauth/token')).length, 0, 'the replaced grant is not refreshed');
  assert.equal(readdirSync(p.queue).length, 1, "node b's queue is untouched and nothing of node a's is added to it");
  assert.equal(summary.queued, 0);
  assert.equal(summary.drained, 0);
});

test('the same node reconnected with other scopes during a flush keeps the new grant, not the refreshed old one', async () => {
  const root = home();
  saveConnection(root, { ...creds('https://node-a.example.invalid', TOKEN_A, ['remember', 'sessions:full']), refreshToken: 'wrt_a' });
  const p = connectionPaths(root, 'node-a.example.invalid');
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (calls === 1) {
      removeConnection(root, 'node-a.example.invalid');
      saveConnection(root, creds('https://node-a.example.invalid', TOKEN_B, ['remember']));
      return new Response('', { status: 401 });
    }
    if (String(url).endsWith('/oauth/token')) return tokenOk('wat_refreshed_old_pairing');
    return mcpOk(init);
  };
  const d = createDelivery({ credentials: loadCredentials(p), paths: p, fetchImpl, summary: newSummary('Stop') });
  await d.deliver({ scope: 'sessions:full', prompts: [] });
  const now = loadCredentials(p);
  assert.equal(now.accessToken, TOKEN_B);
  assert.deepEqual(now.scopes, ['remember']);
  assert.equal(existsSync(p.queue) ? readdirSync(p.queue).length : 0, 0);
});

test('migrateLegacy: an old credentials.json that cannot be read right now stays where it is and moves on a later call', () => {
  const root = home();
  mkdirSync(join(root, 'credentials.json'));
  assert.equal(migrateLegacy(root), null);
  assert.equal(listConnections(root).length, 0);
  assert.ok(existsSync(join(root, 'credentials.json')), 'left in place for the next call');
  assert.deepEqual(readdirSync(root).filter((f) => f.startsWith('credentials.unreadable')), [], 'a read error is not a bad file');
  rmSync(join(root, 'credentials.json'), { recursive: true });
  writeFileSync(join(root, 'credentials.json'), JSON.stringify({ version: 1, ...creds('https://node-a.example.invalid', TOKEN_A) }));
  assert.equal(migrateLegacy(root), 'node-a.example.invalid');
  assert.equal(loadCredentials(connectionPaths(root, 'node-a.example.invalid')).accessToken, TOKEN_A);
});

test('sessionPaths: credentials, queue, question caches and spool per connection; cursors shared; none when not connected', () => {
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
  assert.notEqual(a.spool, b.spool);
});

const JOBB = 'jobb@example.invalid';
const PRIVAT = 'privat@example.invalid';
const short = (account) => createHash('sha256').update(account).digest('hex').slice(0, 8);
const under = (account, nodeUrl, token) => ({ ...creds(nodeUrl, token), harnessAccount: account });

test('accountKey: a second harness account on the same node gets <host>~<short account hash>; the same account keeps its connection', () => {
  const root = home();
  const node = 'https://dittfirma.wybe.me';
  assert.equal(accountKey(root, node, JOBB), 'dittfirma.wybe.me', 'the first one takes the host');
  assert.equal(saveConnection(root, under(JOBB, node, TOKEN_A)), 'dittfirma.wybe.me');
  assert.equal(accountKey(root, node, JOBB), 'dittfirma.wybe.me', 'the same account again');
  assert.equal(accountKey(root, node, 'Jobb@Example.invalid '), 'dittfirma.wybe.me', 'an e-mail compares without case or spaces');
  const second = `dittfirma.wybe.me~${short(PRIVAT)}`;
  assert.equal(accountKey(root, node, PRIVAT), second);
  assert.equal(saveConnection(root, under(PRIVAT, node, TOKEN_B)), second, 'a save under another account derives the name instead of replacing the first');
  assert.equal(loadCredentials(connectionPaths(root, 'dittfirma.wybe.me')).accessToken, TOKEN_A, 'the first account\'s grant is untouched');
  assert.equal(accountKey(root, node, PRIVAT), second);
  assert.equal(findConnection(root, second), second, 'the derived name is a connection name like any other');
  assert.ok(!second.includes('privat'), 'the name never carries the account');
  assert.equal(accountKey(root, node, null), 'dittfirma.wybe.me', 'no account: the host, as before');
  saveConnection(root, under(JOBB, 'https://andrefirma.wybe.me', TOKEN_A), { name: 'jobb' });
  assert.equal(accountKey(root, 'https://andrefirma.wybe.me', JOBB), 'jobb', 'a named connection of this node and account is found');
});

test('accountKey: a connection made before accounts were recorded is taken as this account\'s', () => {
  const root = home();
  saveConnection(root, creds('https://dittfirma.wybe.me', TOKEN_A));
  assert.equal(accountKey(root, 'https://dittfirma.wybe.me', JOBB), 'dittfirma.wybe.me');
});

test('resolveSession: a connection made under the session\'s harness account wins over the plain default; no match falls back to the default', () => {
  const root = home();
  const node = 'https://dittfirma.wybe.me';
  saveConnection(root, under(JOBB, node, TOKEN_A));
  const privat = saveConnection(root, under(PRIVAT, node, TOKEN_B));
  saveConnection(root, creds('https://andrefirma.wybe.me', TOKEN_B));
  assert.equal(resolveSession(root, { sessionId: 'k1', env: {}, account: JOBB }), 'dittfirma.wybe.me', 'the work account\'s session goes to its own connection, not the newest');
  assert.equal(resolveSession(root, { sessionId: 'o1', env: {}, account: () => PRIVAT }), privat, 'the account may be read lazily');
  assert.equal(resolveSession(root, { sessionId: 'x1', env: {}, account: 'per@example.invalid' }), 'andrefirma.wybe.me', 'no match: the default');
  assert.equal(resolveSession(root, { sessionId: 'x2', env: {} }), 'andrefirma.wybe.me', 'no account: the default');
  assert.equal(resolveSession(root, { sessionId: 'e1', env: { [NODE_ENV]: 'andrefirma.wybe.me' }, account: JOBB }), 'andrefirma.wybe.me', 'WYBE_CONNECT_NODE still comes first');
  useConnection(root, privat);
  assert.equal(resolveSession(root, { sessionId: 'k2', env: {}, account: JOBB }), 'dittfirma.wybe.me', 'the account beats a default moved by use');
});

test('resolveSession: the account is not read while there is nothing to choose between', () => {
  const root = home();
  saveConnection(root, under(JOBB, 'https://dittfirma.wybe.me', TOKEN_A));
  let reads = 0;
  assert.equal(resolveSession(root, { sessionId: 'l1', env: {}, account: () => { reads += 1; return PRIVAT; } }), 'dittfirma.wybe.me');
  assert.equal(reads, 0);
});

test('an existing pin is never moved by an account change', () => {
  const root = home();
  const node = 'https://dittfirma.wybe.me';
  saveConnection(root, under(JOBB, node, TOKEN_A));
  const privat = saveConnection(root, under(PRIVAT, node, TOKEN_B));
  assert.equal(resolveSession(root, { sessionId: 'p1', env: {}, account: JOBB }), 'dittfirma.wybe.me');
  assert.equal(resolveSession(root, { sessionId: 'p1', env: {}, account: PRIVAT }), 'dittfirma.wybe.me', 'the harness switched account: the session stays');
  assert.equal(sessionPaths(root, { sessionId: 'p1', env: {}, account: PRIVAT }).connection, 'dittfirma.wybe.me');
  assert.equal(resolveSession(root, { sessionId: 'p2', env: {}, account: PRIVAT }), privat, 'a new session follows the new account');
});

// Through the real SessionStart hooks: the harness account each one reads decides where a new session goes.
const HARNESS_HOOKS = {
  'claude-code': { script: 'packages/claude-code/hooks/session-start.js', home: (root) => root, account: (dir, email) => { writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } })); return { CLAUDE_CONFIG_DIR: dir }; } },
  codex: { script: 'packages/codex/hooks/session-start.js', home: (root) => join(root, 'codex'), account: (dir, email) => {
    const idToken = ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify({ email })).toString('base64url'), 'FAKEsig'].join('.');
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken } }));
    return { CODEX_HOME: dir };
  } },
};
function runStart(script, sessionId, root, extraEnv) {
  return new Promise((resolve, reject) => {
    const base = { ...process.env };
    delete base[NODE_ENV];
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', script)], { env: { ...base, WYBE_CONNECT_HOME: root, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' }));
  });
}
for (const [harness, h] of Object.entries(HARNESS_HOOKS)) {
  test(`${harness} SessionStart hook: a new session goes to the connection of the account the harness is signed in to`, async () => {
    const root = home();
    const hRoot = h.home(root);
    const node = 'https://dittfirma.wybe.me';
    const jobb = saveConnection(hRoot, under(JOBB, node, TOKEN_A));
    const privat = saveConnection(hRoot, under(PRIVAT, node, TOKEN_B));
    const accountDir = mkdtempSync(join(tmpdir(), 'wybe-connect-account-'));
    await runStart(h.script, 'h1', root, h.account(accountDir, JOBB));
    assert.equal(resolveSession(hRoot, { sessionId: 'h1', env: {} }), jobb, 'not the newest connection: the one of this account');
    await runStart(h.script, 'h2', root, h.account(accountDir, PRIVAT));
    assert.equal(resolveSession(hRoot, { sessionId: 'h2', env: {} }), privat);
  });
}
