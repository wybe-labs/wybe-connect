// Where sessions go when connections on one address come and go: a session never reaches another
// colleague's or another account's grant because it was the only one left, a reconnect after a refused
// grant from before colleagues were named brings its sessions back. Every token here is fabricated and
// built at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { colleagueOf, STATIC_CLIENTS } from '../lib/oauth.js';
import { runConnect } from '../lib/connect-cli.js';
import { connectionGrant, connectionNames, connectionPaths, defaultConnection, findConnection, pinnedConnection, removeConnection, resolveSession, saveConnection, sessionConnection, sessionLines, useConnection } from '../lib/connections.js';
import { harnessHome, isRefused, loadCredentials, saveCredentials } from '../lib/home.js';
import { createProxy } from '../lib/mcp-proxy.js';

const NODE = 'https://colleagues.example.invalid';
const HOST = 'colleagues.example.invalid';
const ISSUER = 'https://auth.example.invalid';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (colleague, n = 1) => [b64({ alg: 'EdDSA', typ: 'at+jwt', kid: 'k1' }), b64({ aud: `${NODE}/mcp`, node_id: colleague, jti: `FAKE${n}` }), 'FAKEsig'.repeat(12)].join('.');
const plain = (n) => ['wat_', `FAKEplainFAKEplainFAKE0${n}`].join('');
const refresh = (n) => ['rtk_', `FAKErefreshFAKE0${n}`].join('');
const grant = (accessToken, over = {}) => ({
  nodeUrl: NODE, resource: `${NODE}/mcp`, mcpEndpoint: `${NODE}/mcp`, issuer: ISSUER, tokenEndpoint: `${ISSUER}/oauth/token`,
  clientId: STATIC_CLIENTS['claude-code'], accessToken, refreshToken: refresh(1), expiresAt: null, scopes: ['remember'], ...over,
});
const KEY_A = `${HOST}~col-a`;
const KEY_B = `${HOST}~col-b`;
const ENV = { WYBE_CONNECT_NODE: HOST };
const sink = () => { const s = { text: '', write(t) { s.text += t; } }; return s; };

function withHome(t) {
  const prev = process.env.WYBE_CONNECT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'wc-routing-'));
  process.env.WYBE_CONNECT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.WYBE_CONNECT_HOME; else process.env.WYBE_CONNECT_HOME = prev; rmSync(home, { recursive: true, force: true }); });
  return harnessHome('claude-code');
}

const refuse = (root, key) => {
  const p = connectionPaths(root, key);
  saveCredentials({ ...loadCredentials(p), refusedAt: '2026-01-02T00:00:00.000Z' }, p);
};

/** A token endpoint that refuses every refresh for good: a stored grant cannot be renewed. */
const refusing = async (url) => (String(url) === `${ISSUER}/oauth/token`
  ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
  : new Response('', { status: 404 }));

const queueIn = (root, key, name) => {
  const q = connectionPaths(root, key).queue;
  mkdirSync(q, { recursive: true });
  writeFileSync(join(q, `${name}.json`), '{}');
};
const queued = (root, key) => (existsSync(connectionPaths(root, key).queue) ? readdirSync(connectionPaths(root, key).queue) : []);
const transcriptOf = (root, lines) => {
  const f = join(root, `t-${lines}-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(f, 'l\n'.repeat(lines));
  return f;
};

async function connectAs(creds, fetchImpl) {
  const out = sink();
  const err = sink();
  const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out, err, nextSteps: () => '', fetchImpl, account: null, connectImpl: async () => creds });
  return { code, out: out.text, err: err.text };
}

test('WYBE_CONNECT_NODE=<host> never lands on another colleague left at that address once the host\'s own connection is removed', (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1))); // a connection from before colleagues were named, under the host
  saveConnection(root, grant(token('col-b')));
  assert.equal(resolveSession(root, { sessionId: 's1', env: ENV }), HOST);
  removeConnection(root, HOST); // to connect it again
  assert.equal(resolveSession(root, { sessionId: 's2', env: ENV }), null, 'an unknown name means no connection');
  assert.equal(findConnection(root, HOST), null);
  saveConnection(root, grant(token('col-a')));
  assert.equal(pinnedConnection(root, 's2'), null, 'still none, never the other colleague');
  assert.equal(pinnedConnection(root, 's1'), null);
});

test('the bare host never reaches another harness account\'s connection once the host\'s own is removed, not even for `use`', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1), { harnessAccount: 'first@example.invalid' }));
  saveConnection(root, grant(plain(2), { harnessAccount: 'second@example.invalid' }));
  const [, other] = connectionNames(root);
  removeConnection(root, HOST);
  assert.equal(findConnection(root, HOST), null);
  assert.equal(sessionConnection(root, { env: ENV }), null);
  const err = sink();
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['use', HOST], out: sink(), err, nextSteps: () => '' }), 1);
  assert.ok(err.text.includes(other), 'refused, listing the full name to choose');
  assert.equal(findConnection(root, other), other, 'its full name still finds it');
});

test('a refused connection from before colleagues were named is taken over in place by the first colleague signed in there: its sessions come back', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1)));
  resolveSession(root, { sessionId: 's1', env: {} });
  refuse(root, HOST);
  const r = await connectAs(grant(token('col-a'), { refreshToken: refresh(2) }), refusing);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(connectionNames(root), [HOST]);
  const now = loadCredentials(connectionPaths(root, HOST));
  assert.equal(now.accessToken, token('col-a'));
  assert.equal(isRefused(now), false);
  assert.equal(pinnedConnection(root, 's1'), HOST);
  assert.equal(sessionConnection(root, { env: ENV }), HOST);
});

test('once a colleague is connected at the address, a refused connection from before colleagues is never taken over, nor its sessions, queue or lines split off', (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1)));
  saveConnection(root, grant(token('col-a')));
  const transcript = transcriptOf(root, 5);
  useConnection(root, HOST);
  resolveSession(root, { sessionId: 's1', env: {}, transcriptPath: transcript });
  queueIn(root, HOST, 'older-payload');
  refuse(root, HOST);
  assert.equal(saveConnection(root, grant(token('col-a', 2))), KEY_A, 'the colleague signs in again to its own');
  writeFileSync(transcript, 'l\n'.repeat(9));
  assert.equal(pinnedConnection(root, 's1'), HOST, 'the session stays where it was, for the person to move');
  assert.equal(saveConnection(root, grant(token('col-b'))), KEY_B, 'another colleague does not take the older name');
  assert.equal(loadCredentials(connectionPaths(root, HOST)).accessToken, plain(1));
  assert.deepEqual(queued(root, KEY_B), []);
  assert.deepEqual(queued(root, KEY_A), []);
  assert.deepEqual(queued(root, HOST), ['older-payload.json']);
  assert.deepEqual(sessionLines(root, 's1', KEY_A), []);
  assert.deepEqual(sessionLines(root, 's1', KEY_B), []);
});

test('a refused connection of another harness account is never taken over: its queue and sessions stay its own', (t) => {
  const root = withHome(t);
  const first = saveConnection(root, grant(plain(1), { harnessAccount: 'first@example.invalid' }));
  const second = saveConnection(root, grant(plain(2), { harnessAccount: 'second@example.invalid' }));
  resolveSession(root, { sessionId: 's-first', env: {}, account: 'first@example.invalid', transcriptPath: transcriptOf(root, 3) });
  resolveSession(root, { sessionId: 's-second', env: {}, account: 'second@example.invalid', transcriptPath: transcriptOf(root, 3) });
  assert.equal(pinnedConnection(root, 's-second'), second);
  queueIn(root, second, 'second-payload');
  refuse(root, second);
  const k = saveConnection(root, grant(token('col-a'), { harnessAccount: 'first@example.invalid' }));
  assert.notEqual(k, second);
  assert.notEqual(k, first, 'a live connection is not taken over either');
  assert.equal(loadCredentials(connectionPaths(root, second)).accessToken, plain(2));
  assert.deepEqual(queued(root, second), ['second-payload.json']);
  assert.deepEqual(queued(root, k), []);
  assert.equal(pinnedConnection(root, 's-second'), second);
});

test('a refused connection from before colleagues, recorded under another account, is not taken over by a sign-in under none or another', (t) => {
  for (const account of [null, 'other@example.invalid']) {
    const root = withHome(t);
    saveConnection(root, grant(plain(1), { harnessAccount: 'owner@example.invalid' }), { name: HOST });
    refuse(root, HOST);
    const k = saveConnection(root, grant(token('col-a'), account ? { harnessAccount: account } : {}));
    assert.equal(k, KEY_A, String(account));
    assert.equal(loadCredentials(connectionPaths(root, HOST)).accessToken, plain(1));
  }
});

test('the same account (or one never recorded) does take over its refused connection under the host\'s own name; never one with a name of its own', (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1), { harnessAccount: 'owner@example.invalid' }));
  resolveSession(root, { sessionId: 's1', env: {} });
  saveConnection(root, grant(plain(2)), { name: 'work' });
  resolveSession(root, { sessionId: 's2', env: {} });
  refuse(root, HOST);
  refuse(root, 'work');
  assert.equal(saveConnection(root, grant(token('col-a'), { harnessAccount: 'Owner@Example.invalid' })), HOST);
  assert.equal(pinnedConnection(root, 's1'), HOST);
  assert.equal(pinnedConnection(root, 's2'), 'work', 'a connection with a name of its own stays for the person');
  assert.equal(loadCredentials(connectionPaths(root, 'work')).accessToken, plain(2));
});

test('sessions never move between two different colleagues, refused or not, and a refused colleague is never taken over by another', (t) => {
  const root = withHome(t);
  saveConnection(root, grant(token('col-b')));
  resolveSession(root, { sessionId: 's-b', env: {} });
  refuse(root, KEY_B);
  assert.equal(saveConnection(root, grant(token('col-a'))), KEY_A);
  assert.equal(pinnedConnection(root, 's-b'), KEY_B);
  assert.equal(loadCredentials(connectionPaths(root, KEY_B)).accessToken, token('col-b'));
});

test('a live connection from before colleagues were named is left as it is: a colleague signed in there gets its own', (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1)));
  resolveSession(root, { sessionId: 's1', env: {} });
  assert.equal(saveConnection(root, grant(token('col-a'))), KEY_A);
  assert.equal(pinnedConnection(root, 's1'), HOST);
  assert.equal(loadCredentials(connectionPaths(root, HOST)).accessToken, plain(1));
});

test('--name onto another harness account\'s connection, refused or not, signs in and replaces it: the person named it', async (t) => {
  for (const refused of [true, false]) {
    const root = withHome(t);
    const theirs = saveConnection(root, grant(plain(1), { harnessAccount: 'second@example.invalid' }), { name: 'theirs' });
    resolveSession(root, { sessionId: 's-second', env: {}, account: 'second@example.invalid', transcriptPath: transcriptOf(root, 3) });
    if (refused) refuse(root, theirs);
    let signIns = 0;
    const err = sink();
    const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE, '--name', theirs], out: sink(), err, nextSteps: () => '', fetchImpl: refusing, account: 'first@example.invalid', connectImpl: async () => { signIns += 1; return grant(plain(2), { harnessAccount: 'first@example.invalid' }); } });
    assert.equal(code, 0, `${refused}: ${err.text}`);
    assert.equal(signIns, 1);
    assert.equal(loadCredentials(connectionPaths(root, theirs)).accessToken, plain(2));
    assert.equal(loadCredentials(connectionPaths(root, theirs)).harnessAccount, 'first@example.invalid');
    assert.equal(pinnedConnection(root, 's-second'), theirs, 'its sessions stay on the name');
    assert.equal(saveConnection(root, grant(plain(3), { harnessAccount: 'second@example.invalid' }), { name: theirs }), theirs, 'and back, by name');
    assert.equal(saveConnection(root, grant(plain(4)), { name: theirs }), theirs, 'a caller with no account, by name');
  }
});

test('--name onto a connection of the same harness account, or one that recorded none, replaces it as before', (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1), { harnessAccount: 'owner@example.invalid' }), { name: 'mine' });
  refuse(root, 'mine');
  assert.equal(saveConnection(root, grant(token('col-a'), { harnessAccount: 'Owner@Example.invalid' }), { name: 'mine' }), 'mine');
  saveConnection(root, grant(plain(2)), { name: 'unrecorded' });
  assert.equal(saveConnection(root, grant(plain(3), { harnessAccount: 'owner@example.invalid' }), { name: 'unrecorded' }), 'unrecorded');
  assert.equal(loadCredentials(connectionPaths(root, 'unrecorded')).accessToken, plain(3));
});

test('a colleague\'s refused connection under another harness account is never taken over by the same colleague under this one, nor are its sessions moved', (t) => {
  const root = withHome(t);
  const theirs = saveConnection(root, grant(token('col-a'), { harnessAccount: 'second@example.invalid' }));
  resolveSession(root, { sessionId: 's-second', env: {}, account: 'second@example.invalid', transcriptPath: transcriptOf(root, 3) });
  queueIn(root, theirs, 'second-payload');
  refuse(root, theirs);
  for (const account of ['first@example.invalid', null]) {
    let k;
    try {
      k = saveConnection(root, grant(token('col-a', 2), account ? { harnessAccount: account } : {}));
    } catch (e) {
      assert.match(e.message, /another account/, String(account));
    }
    assert.notEqual(k, theirs, String(account));
    assert.equal(loadCredentials(connectionPaths(root, theirs)).accessToken, token('col-a'));
    assert.deepEqual(queued(root, theirs), ['second-payload.json']);
    assert.equal(pinnedConnection(root, 's-second'), theirs);
  }
});

test('connect.js under another account next to a refused connection: signs in to a connection of its own and says how to remove the other; one that records no account is refused before the browser opens', async (t) => {
  const root = withHome(t);
  const theirs = saveConnection(root, grant(plain(1), { harnessAccount: 'second@example.invalid' }));
  resolveSession(root, { sessionId: 's-second', env: {}, account: 'second@example.invalid', transcriptPath: transcriptOf(root, 3) });
  queueIn(root, theirs, 'second-payload');
  refuse(root, theirs);
  const out = sink();
  const err = sink();
  const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out, err, nextSteps: () => '', fetchImpl: refusing, account: 'first@example.invalid', connectImpl: async () => grant(plain(2)) });
  assert.equal(code, 0, err.text);
  const mine = connectionNames(root).find((k) => k !== theirs);
  assert.ok(mine);
  assert.equal(loadCredentials(connectionPaths(root, theirs)).accessToken, plain(1));
  assert.deepEqual(queued(root, theirs), ['second-payload.json']);
  assert.equal(pinnedConnection(root, 's-second'), theirs);
  assert.ok(out.text.includes(`connect.js remove ${theirs}`), out.text);
  assert.ok(!out.text.includes('@'), 'the account is never printed');

  let signIns = 0;
  const none = sink();
  const refusedCode = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out: sink(), err: none, nextSteps: () => '', fetchImpl: refusing, account: null, connectImpl: async () => { signIns += 1; return grant(plain(3)); } });
  assert.equal(refusedCode, 1);
  assert.equal(signIns, 0, 'refused before the browser opens');
  assert.match(none.text, /another account.*--name.*remove/);
  assert.equal(loadCredentials(connectionPaths(root, theirs)).accessToken, plain(1));
});

test('a bare host never reaches another account\'s colleague connection: `use --session` and remove refuse and list the full names', async (t) => {
  const root = withHome(t);
  const mine = saveConnection(root, grant(token('col-x'), { harnessAccount: 'first@example.invalid' }));
  const theirs = saveConnection(root, grant(token('col-y'), { harnessAccount: 'second@example.invalid' }));
  queueIn(root, theirs, 'second-payload');
  removeConnection(root, mine);
  const use = sink();
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['use', HOST, '--session', 'sA'], out: sink(), err: use, nextSteps: () => '', account: 'first@example.invalid' }), 1);
  assert.ok(use.text.includes(theirs), use.text);
  assert.notEqual(pinnedConnection(root, 'sA'), theirs);
  const rm = sink();
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['remove', HOST], out: sink(), err: rm, nextSteps: () => '', account: 'first@example.invalid' }), 1);
  assert.ok(rm.text.includes(theirs), rm.text);
  assert.deepEqual(connectionNames(root), [theirs]);
  assert.deepEqual(queued(root, theirs), ['second-payload.json']);
});

test('connect.js --name onto another account\'s live connection renews it in place: no sign-in, the account it recorded stays', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1), { harnessAccount: 'first@example.invalid' }), { name: 'mine' });
  saveConnection(root, grant(plain(2), { harnessAccount: 'second@example.invalid' }), { name: 'theirs' });
  useConnection(root, 'mine');
  let tokenCalls = 0;
  const renewing = async () => {
    tokenCalls += 1;
    return new Response(JSON.stringify({ access_token: plain(3), refresh_token: refresh(3), expires_in: 3600, scope: 'remember' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  for (const account of ['first@example.invalid', null]) {
    let signIns = 0;
    const err = sink();
    const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE, '--name', 'theirs'], out: sink(), err, nextSteps: () => '', fetchImpl: renewing, account, connectImpl: async () => { signIns += 1; return grant(plain(4)); } });
    assert.equal(code, 0, err.text);
    assert.equal(signIns, 0);
  }
  assert.equal(tokenCalls, 2);
  assert.equal(loadCredentials(connectionPaths(root, 'theirs')).accessToken, plain(3));
  assert.equal(loadCredentials(connectionPaths(root, 'theirs')).harnessAccount, 'second@example.invalid');
  assert.equal(loadCredentials(connectionPaths(root, 'mine')).accessToken, plain(1));
});

test('a plain connect (no --name) never renews or replaces another account\'s live connection under the host\'s own name: it signs in to one of its own', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1), { harnessAccount: 'second@example.invalid' }));
  queueIn(root, HOST, 'second-payload');
  resolveSession(root, { sessionId: 's-second', env: {}, account: 'second@example.invalid', transcriptPath: transcriptOf(root, 3) });
  let tokenCalls = 0;
  const renewing = async () => {
    tokenCalls += 1;
    return new Response(JSON.stringify({ access_token: plain(3), refresh_token: refresh(3), expires_in: 3600, scope: 'remember' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let signIns = 0;
  const out = sink();
  const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out, err: out, nextSteps: () => '', fetchImpl: renewing, account: 'first@example.invalid', connectImpl: async () => { signIns += 1; return grant(plain(2), { harnessAccount: 'first@example.invalid' }); } });
  assert.equal(code, 0, out.text);
  assert.equal(tokenCalls, 0, 'their grant is never refreshed');
  assert.equal(signIns, 1);
  assert.equal(loadCredentials(connectionPaths(root, HOST)).accessToken, plain(1));
  assert.deepEqual(queued(root, HOST), ['second-payload.json']);
  assert.equal(pinnedConnection(root, 's-second'), HOST);
  assert.equal(connectionNames(root).length, 2);
});

const LIB = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'connections.js')).href;
/** Two processes that call saveConnection at the same instant; resolves with what each printed. */
function saveTogether(root, grants) {
  const at = Date.now() + 400;
  const code = `const C = await import(${JSON.stringify(LIB)}); const g = JSON.parse(process.argv[1]); while (Date.now() < ${at}); try { console.log(C.saveConnection(${JSON.stringify(root)}, g)); } catch (e) { console.log('ERR ' + e.message); }`;
  return Promise.all(grants.map((g) => new Promise((res) => {
    let out = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(g)]);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => res(out.trim()));
  })));
}

test('two sign-ins that finish at the same moment both keep their grant, same account or not', async (t) => {
  for (let i = 0; i < 4; i++) {
    const root = withHome(t);
    saveConnection(root, grant(plain(1), { harnessAccount: 'first@example.invalid' }));
    refuse(root, HOST);
    const outs = await saveTogether(root, [grant(token('col-x'), { harnessAccount: 'first@example.invalid' }), grant(token('col-y'), { harnessAccount: 'first@example.invalid' })]);
    const held = connectionNames(root).map((k) => colleagueOf(connectionGrant(root, k)?.accessToken));
    assert.ok(held.includes('col-x') && held.includes('col-y'), `same account, trial ${i}: ${outs.join(' | ')} -> ${held}`);

    const other = withHome(t);
    const both = await saveTogether(other, [grant(token('col-x'), { harnessAccount: 'first@example.invalid' }), grant(token('col-x', 2), { harnessAccount: 'second@example.invalid' })]);
    assert.equal(connectionNames(other).length, 2, `two accounts, trial ${i}: ${both.join(' | ')}`);
  }
});

test('a name that is another connection\'s short (8.3) alias on this system is refused, never written into that connection', { skip: process.platform !== 'win32' }, (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1)), { name: 'older-unnamed-conn' });
  let listing = '';
  try {
    listing = execFileSync('cmd', ['/c', 'dir', '/x', join(root, 'connections')], { encoding: 'utf8' });
  } catch {
    // no listing: nothing to check
  }
  const alias = listing.match(/\s([A-Z0-9_-]{1,6}~\d)\s+older-unnamed-conn\s*$/m)?.[1];
  if (!alias) { t.skip('this volume makes no 8.3 names'); return; }
  assert.throws(() => saveConnection(root, grant(plain(2), { harnessAccount: 'first@example.invalid' }), { name: alias.toLowerCase() }), /another connection/);
  const held = loadCredentials(connectionPaths(root, 'older-unnamed-conn'));
  assert.equal(held.accessToken, plain(1));
  assert.equal(held.harnessAccount, undefined);
});

test('the plugin connect tool checks the account before the browser opens, and says what it can do instead', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1), { harnessAccount: 'second@example.invalid' }));
  let signIns = 0;
  const proxy = createProxy({ root, env: {}, clientId: STATIC_CLIENTS['claude-code'], harnessAccount: () => null, fetchImpl: refusing, connectImpl: (_url, opts) => { signIns += 1; opts.onUrl(`${ISSUER}/oauth/authorize?x`); return Promise.resolve(grant(plain(2))); } });
  const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect', arguments: { node_url: NODE } } });
  const text = r.result.content[0].text;
  assert.equal(r.result.isError, true);
  assert.equal(signIns, 0, 'no browser');
  assert.match(text, /another account/);
  assert.doesNotMatch(text, /--name/, 'the tool takes no --name');
  assert.match(text, /remove/);
  assert.ok(!text.includes('@'));
  assert.equal(loadCredentials(connectionPaths(root, HOST)).accessToken, plain(1));
});

/** B connected first and holds the host's own name, with a queued payload; A has a connection of its own beside it. */
function hostOwnedByOther(t) {
  const root = withHome(t);
  const theirs = saveConnection(root, grant(plain(1), { harnessAccount: 'second@example.invalid' }));
  const mine = saveConnection(root, grant(plain(2), { harnessAccount: 'first@example.invalid' }));
  queueIn(root, theirs, 'second-payload');
  resolveSession(root, { sessionId: 'sess-A', env: { WYBE_CONNECT_NODE: mine } });
  return { root, theirs, mine };
}

test('`use` and remove act on a connection recorded under another account, by host or by URL: the person named it', async (t) => {
  for (const account of ['First@Example.invalid', null]) {
    const { root, theirs } = hostOwnedByOther(t);
    assert.equal(theirs, HOST);
    const cli = async (argv) => {
      const out = sink();
      const err = sink();
      const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv, out, err, nextSteps: () => '', account });
      return { code, text: out.text + err.text };
    };
    assert.equal((await cli(['use', HOST, '--session', 'sess-A'])).code, 0, String(account));
    assert.equal(pinnedConnection(root, 'sess-A'), theirs);
    assert.equal((await cli(['use', `${NODE}/mcp`])).code, 0);
    assert.equal(defaultConnection(root), theirs);
    const rm = await cli(['remove', HOST]);
    assert.equal(rm.code, 0, rm.text);
    assert.match(rm.text, /1 queued payload/);
    assert.ok(!existsSync(join(root, 'connections', theirs)));
  }
});

test('`use` and remove of a connection that recorded no account work under any account, or none, as today', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1)));
  for (const account of ['first@example.invalid', null]) {
    assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['use', HOST, '--session', 'sess-1'], out: sink(), err: sink(), nextSteps: () => '', account }), 0, String(account));
  }
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['remove', HOST], out: sink(), err: sink(), nextSteps: () => '', account: 'first@example.invalid' }), 0);
});

test('`use --session` with the host\'s own name moves the session to the colleague there, whichever account made it', async (t) => {
  const root = withHome(t);
  saveConnection(root, grant(plain(1), { harnessAccount: 'second@example.invalid' }));
  refuse(root, HOST);
  assert.equal(saveConnection(root, grant(token('col-b'), { harnessAccount: 'second@example.invalid' })), HOST);
  const mine = saveConnection(root, grant(token('col-a'), { harnessAccount: 'first@example.invalid' }));
  resolveSession(root, { sessionId: 'sess-A', env: { WYBE_CONNECT_NODE: mine } });
  assert.equal(pinnedConnection(root, 'sess-A'), mine, 'automatically, never the other account\'s');
  const err = sink();
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['use', HOST, '--session', 'sess-A'], out: sink(), err, nextSteps: () => '', account: 'first@example.invalid' }), 0, err.text);
  assert.equal(pinnedConnection(root, 'sess-A'), HOST);
});

test('bin/connect.js acts on another account\'s connection when the person names it', (t) => {
  const { root, theirs } = hostOwnedByOther(t);
  const config = mkdtempSync(join(tmpdir(), 'wc-routing-config-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'first@example.invalid' } }));
  const bin = join(import.meta.dirname, '..', 'packages', 'claude-code', 'bin', 'connect.js');
  const env = { ...process.env, WYBE_CONNECT_HOME: process.env.WYBE_CONNECT_HOME, CLAUDE_CONFIG_DIR: config };
  const use = spawnSync(process.execPath, [bin, 'use', HOST, '--session', 'sess-A'], { env, encoding: 'utf8' });
  assert.equal(use.status, 0, use.stdout + use.stderr);
  assert.equal(pinnedConnection(root, 'sess-A'), theirs);
  const rm = spawnSync(process.execPath, [bin, 'remove', `${NODE}/mcp`], { env, encoding: 'utf8' });
  assert.equal(rm.status, 0, rm.stdout + rm.stderr);
  assert.ok(!existsSync(join(root, 'connections', theirs)));
});

const storeLock = (root, ageMs) => {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'connections.lock'), JSON.stringify({ pid: process.pid, token: 'other', at: new Date(Date.now() - ageMs).toISOString() }));
};

test('a connection-store lock left by a live but unrelated process for over a minute does not block a save', (t) => {
  const root = withHome(t);
  storeLock(root, 120e3);
  assert.equal(saveConnection(root, grant(plain(1))), HOST);
});

test('a busy connection store is refused before the browser opens, with its own message and a next step', async (t) => {
  const root = withHome(t);
  storeLock(root, 0);
  let signIns = 0;
  const err = sink();
  const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out: sink(), err, nextSteps: () => '', fetchImpl: refusing, account: null, connectImpl: async () => { signIns += 1; return grant(plain(1)); } });
  assert.equal(code, 1);
  assert.equal(signIns, 0, 'no sign-in is made only to be dropped');
  assert.match(err.text, /connection store/);
  assert.match(err.text, /try again in a moment/);
  assert.doesNotMatch(err.text, /distil/);
  assert.throws(() => saveConnection(root, grant(plain(1))), /connection store.*try again in a moment/s);

  const proxy = createProxy({ root, env: {}, clientId: STATIC_CLIENTS['claude-code'], harnessAccount: () => null, fetchImpl: refusing, connectImpl: (_url, opts) => { signIns += 1; opts.onUrl(`${ISSUER}/oauth/authorize?x`); return Promise.resolve(grant(plain(2))); } });
  const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect', arguments: { node_url: NODE } } });
  assert.equal(signIns, 0, 'the plugin tool does not open the browser either');
  assert.match(r.result.content[0].text, /try again in a moment/);
});

/** Makes connection `key`'s credentials.json unreadable: cut short, or (as a file held open elsewhere reads) not a file. */
const unreadable = (root, key, how) => {
  const f = connectionPaths(root, key).credentials;
  rmSync(f, { force: true });
  if (how === 'truncated') writeFileSync(f, '{ "version": 1, "nodeUrl": "https://colle');
  else mkdirSync(f);
};

for (const how of ['truncated', 'busy']) {
  test(`\`use\` and remove of a connection whose grant cannot be read now (${how}) refuse and keep it, its queue and sessions`, async (t) => {
    const { root, theirs, mine } = hostOwnedByOther(t);
    unreadable(root, theirs, how);
    for (const argv of [['remove', theirs], ['use', theirs, '--session', 'sess-A'], ['use', theirs]]) {
      for (const account of ['first@example.invalid', null]) {
        const err = sink();
        const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv, out: sink(), err, nextSteps: () => '', account });
        assert.equal(code, 1, `${argv.join(' ')} as ${account}`);
        assert.match(err.text, /can't read connection .* right now/);
        assert.match(err.text, /try again/);
      }
    }
    assert.ok(existsSync(join(root, 'connections', theirs)), 'its folder stays');
    assert.deepEqual(queued(root, theirs), ['second-payload.json']);
    assert.equal(pinnedConnection(root, 'sess-A'), mine);
    assert.equal(defaultConnection(root), mine);
    assert.throws(() => removeConnection(root, theirs, { account: 'first@example.invalid' }), (e) => e.code === 'EUNREADABLE');
  });

  test(`a sign-in never writes over a connection whose grant cannot be read now (${how}): refused before the browser opens`, async (t) => {
    const root = withHome(t);
    saveConnection(root, grant(plain(1), { harnessAccount: 'second@example.invalid' }));
    queueIn(root, HOST, 'second-payload');
    saveConnection(root, grant(token('col-a'), { harnessAccount: 'second@example.invalid' }));
    unreadable(root, HOST, how);
    unreadable(root, KEY_A, how);
    let signIns = 0;
    const err = sink();
    const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv: [NODE], out: sink(), err, nextSteps: () => '', fetchImpl: refusing, account: 'first@example.invalid', connectImpl: async () => { signIns += 1; return grant(plain(2), { harnessAccount: 'first@example.invalid' }); } });
    assert.equal(code, 1, err.text);
    assert.equal(signIns, 0);
    assert.match(err.text, /can't read connection .* right now/);
    for (const account of ['first@example.invalid', null]) {
      assert.throws(() => saveConnection(root, grant(plain(3), account ? { harnessAccount: account } : {})), (e) => e.code === 'EUNREADABLE', `plain as ${account}`);
      assert.throws(() => saveConnection(root, grant(token('col-a', 3), account ? { harnessAccount: account } : {})), (e) => e.code === 'EUNREADABLE', `colleague as ${account}`);
    }
    assert.deepEqual(queued(root, HOST), ['second-payload.json']);
    if (how === 'truncated') assert.match(readFileSync(connectionPaths(root, HOST).credentials, 'utf8'), /^\{ "version": 1, "nodeUrl": "https:\/\/colle$/);
  });
}

test('a session on a connection whose grant cannot be read now is not moved by a sign-in to the same address, and the sign-in does not take its name', (t) => {
  const root = withHome(t);
  saveConnection(root, grant(token('col-a'), { harnessAccount: 'second@example.invalid' }));
  resolveSession(root, { sessionId: 'sess-B', env: { WYBE_CONNECT_NODE: KEY_A } });
  refuse(root, KEY_A);
  unreadable(root, KEY_A, 'truncated');
  assert.throws(() => saveConnection(root, grant(token('col-a', 2), { harnessAccount: 'first@example.invalid' })), (e) => e.code === 'EUNREADABLE');
  const mine = saveConnection(root, grant(token('col-a', 2), { harnessAccount: 'first@example.invalid' }), { name: 'mine' });
  assert.equal(mine, 'mine');
  assert.notEqual(pinnedConnection(root, 'sess-B'), mine);
  saveCredentials(grant(token('col-a'), { harnessAccount: 'second@example.invalid', refusedAt: '2026-01-02T00:00:00.000Z' }), connectionPaths(root, KEY_A));
  assert.equal(pinnedConnection(root, 'sess-B'), KEY_A, 'readable again, the session is where it was');
});

test('a credentials.json holding the JSON literal null is unreadable, not missing: no sign-in takes its name, queue or sessions', async (t) => {
  const { root, theirs } = hostOwnedByOther(t);
  resolveSession(root, { sessionId: 'sess-B', env: { WYBE_CONNECT_NODE: theirs } });
  writeFileSync(connectionPaths(root, theirs).credentials, 'null');
  for (const account of ['third@example.invalid', undefined]) { // ones with no connection of their own there
    assert.throws(() => saveConnection(root, grant(plain(5), account ? { harnessAccount: account } : {})), (e) => e.code === 'EUNREADABLE', String(account));
  }
  const err = sink();
  assert.equal(await runConnect({ harness: 'claude-code', clientName: 'x', argv: ['remove', theirs], out: sink(), err, nextSteps: () => '', account: 'first@example.invalid' }), 1);
  assert.match(err.text, /can't read connection/);
  assert.equal(readFileSync(connectionPaths(root, theirs).credentials, 'utf8'), 'null');
  assert.deepEqual(queued(root, theirs), ['second-payload.json']);
  saveCredentials(grant(plain(1), { harnessAccount: 'second@example.invalid' }), connectionPaths(root, theirs));
  assert.equal(pinnedConnection(root, 'sess-B'), theirs);
});

test('WYBE_CONNECT_NODE naming a connection that cannot be read now leaves the session unpinned; the next hook pins it once it reads', (t) => {
  const { root, theirs } = hostOwnedByOther(t);
  unreadable(root, theirs, 'truncated');
  assert.equal(resolveSession(root, { sessionId: 'sess-U', env: { WYBE_CONNECT_NODE: theirs } }), null);
  assert.equal(pinnedConnection(root, 'sess-U'), undefined, 'not fixed to none');
  saveCredentials(grant(plain(1), { harnessAccount: 'second@example.invalid' }), connectionPaths(root, theirs));
  assert.equal(resolveSession(root, { sessionId: 'sess-U', env: { WYBE_CONNECT_NODE: theirs } }), theirs);
  assert.equal(pinnedConnection(root, 'sess-U'), theirs);
  assert.equal(resolveSession(root, { sessionId: 'sess-none', env: { WYBE_CONNECT_NODE: 'nowhere.example.invalid' } }), null);
  assert.equal(pinnedConnection(root, 'sess-none'), null, 'an unknown name still fixes the session to none');
});
