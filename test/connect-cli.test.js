import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseConnectArgs, runConnect } from '../lib/connect-cli.js';
import { harnessHome, HARNESSES } from '../lib/home.js';

const TOKEN = ['wat_', 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');

const sink = () => {
  const s = { text: '', write: (x) => { s.text += x; } };
  return s;
};

test('parseConnectArgs: url, scopes, help and the refusals', () => {
  assert.deepEqual(parseConnectArgs(['https://dittfirma.wybe.me']).scopes, ['remember', 'conversations', 'sessions:light', 'sessions:full']);
  assert.deepEqual(parseConnectArgs(['https://dittfirma.wybe.me', '--scopes', 'remember, sessions:light']), { nodeUrl: 'https://dittfirma.wybe.me', scopes: ['remember', 'sessions:light'] });
  assert.deepEqual(parseConnectArgs(['-h']), { help: true });
  assert.match(parseConnectArgs([]).error, /missing/);
  assert.match(parseConnectArgs(['https://a.wybe.me', 'extra']).error, /unexpected/);
  assert.match(parseConnectArgs(['https://a.wybe.me', '--scopes', 'recall']).error, /unknown scope\(s\): recall/);
  assert.deepEqual(parseConnectArgs(['https://a.wybe.me', '--name', 'second']), { nodeUrl: 'https://a.wybe.me', scopes: ['remember', 'conversations', 'sessions:light', 'sessions:full'], name: 'second' });
  assert.match(parseConnectArgs(['https://a.wybe.me', '--name', '../x']).error, /bad connection name/);
  assert.match(parseConnectArgs(['https://a.wybe.me', '--name']).error, /bad connection name/);
  assert.deepEqual(parseConnectArgs(['list']), { command: 'list' });
  assert.deepEqual(parseConnectArgs(['use', 'a.wybe.me']), { command: 'use', ref: 'a.wybe.me', sessionId: null });
  assert.deepEqual(parseConnectArgs(['use', 'a.wybe.me', '--session', 's-1']), { command: 'use', ref: 'a.wybe.me', sessionId: 's-1' });
  assert.deepEqual(parseConnectArgs(['remove', 'a.wybe.me']), { command: 'remove', ref: 'a.wybe.me' });
  assert.match(parseConnectArgs(['use']).error, /missing <name>/);
  assert.match(parseConnectArgs(['remove']).error, /missing <name>/);
  assert.match(parseConnectArgs(['list', 'x']).error, /unexpected/);
});

test('every bin/connect.js runs the shared CLI: list on an empty home, use refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'wybe-connect-bin-'));
  for (const pkg of HARNESSES) {
    const bin = join(import.meta.dirname, '..', 'packages', pkg, 'bin', 'connect.js');
    const env = { ...process.env, WYBE_CONNECT_HOME: home };
    const list = spawnSync(process.execPath, [bin, 'list'], { env, encoding: 'utf8' });
    assert.equal(list.status, 0, `${pkg}: ${list.stderr}`);
    assert.match(list.stdout, /No connections/);
    const use = spawnSync(process.execPath, [bin, 'use', 'nope.wybe.me'], { env, encoding: 'utf8' });
    assert.equal(use.status, 1, pkg);
    assert.match(use.stderr, /no connection named nope\.wybe\.me/);
  }
});

test('harnessHome: Claude Code keeps the root, Codex and Cursor get their own directories', () => {
  assert.deepEqual(HARNESSES, ['claude-code', 'codex', 'cursor']);
  assert.equal(harnessHome('claude-code', '/h'), '/h');
  assert.equal(harnessHome('codex', '/h').replace(/\\/g, '/'), '/h/codex');
  assert.equal(harnessHome('cursor', '/h').replace(/\\/g, '/'), '/h/cursor');
  assert.throws(() => harnessHome('chatgpt', '/h'), /unknown harness/);
});

test('runConnect: stores the grant in the harness home under the harness client name, prints next steps, never the token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wybe-connect-cli-'));
  const prev = process.env.WYBE_CONNECT_HOME;
  process.env.WYBE_CONNECT_HOME = home;
  try {
    const out = sink();
    const err = sink();
    let seen;
    const code = await runConnect({
      harness: 'cursor',
      clientName: 'wybe-connect (Cursor)',
      argv: ['https://dittfirma.wybe.me', '--scopes', 'sessions:light'],
      out,
      err,
      nextSteps: (c) => `next: ${c.mcpEndpoint}\n`,
      connectImpl: async (url, opts) => {
        seen = { url, ...opts };
        return { nodeUrl: url, mcpEndpoint: `${url}/mcp`, accessToken: TOKEN, refreshToken: null, scopes: opts.scopes };
      },
    });
    assert.equal(code, 0);
    assert.equal(seen.clientName, 'wybe-connect (Cursor)');
    assert.deepEqual(seen.scopes, ['sessions:light']);
    const stored = JSON.parse(readFileSync(join(home, 'cursor', 'connections', 'dittfirma.wybe.me', 'credentials.json'), 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.accessToken, TOKEN);
    assert.match(out.text, /Connected to https:\/\/dittfirma\.wybe\.me\nGranted scopes: sessions:light\n/);
    assert.match(out.text, /next: https:\/\/dittfirma\.wybe\.me\/mcp/);
    assert.ok(!out.text.includes(TOKEN) && !err.text.includes(TOKEN));

    const failed = sink();
    assert.equal(await runConnect({ harness: 'codex', clientName: 'x', argv: ['https://dittfirma.wybe.me'], out: sink(), err: failed, nextSteps: () => '', connectImpl: async () => { throw new Error('registration refused: HTTP 429'); } }), 1);
    assert.match(failed.text, /connect failed: registration refused: HTTP 429/);
    assert.equal(await runConnect({ harness: 'codex', clientName: 'x', argv: [], out: sink(), err: sink(), nextSteps: () => '' }), 2);
  } finally {
    if (prev === undefined) delete process.env.WYBE_CONNECT_HOME;
    else process.env.WYBE_CONNECT_HOME = prev;
  }
});

test('runConnect: two nodes coexist; list, use (default and one session) and remove, never a token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wybe-connect-cli-'));
  const prev = process.env.WYBE_CONNECT_HOME;
  process.env.WYBE_CONNECT_HOME = home;
  const fake = (token) => async (url, opts) => ({ nodeUrl: url, mcpEndpoint: `${url}/mcp`, accessToken: token, refreshToken: null, scopes: opts.scopes, connectedAt: '2026-10-22T08:00:00.000Z' });
  const run = async (argv, connectImpl) => {
    const out = sink();
    const err = sink();
    const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv, out, err, nextSteps: () => '', connectImpl });
    return { code, out: out.text, err: err.text };
  };
  try {
    assert.equal((await run(['https://dittfirma.wybe.me'], fake(TOKEN))).code, 0);
    const second = await run(['https://andrefirma.wybe.me', '--scopes', 'remember'], fake(`${TOKEN}2`));
    assert.equal(second.code, 0);
    assert.match(second.out, /Also connected: dittfirma\.wybe\.me/);
    assert.match(second.out, /andrefirma\.wybe\.me is now the default/);

    const list = await run(['list']);
    assert.equal(list.code, 0);
    assert.match(list.out, /^\* andrefirma\.wybe\.me +https:\/\/andrefirma\.wybe\.me +remember\b/m);
    assert.match(list.out, /^  dittfirma\.wybe\.me +https:\/\/dittfirma\.wybe\.me +remember, conversations, sessions:light, sessions:full\b/m);
    assert.ok(!list.out.includes('wat_') && !list.err.includes('wat_'));

    const use = await run(['use', 'dittfirma.wybe.me']);
    assert.equal(use.code, 0);
    assert.match(use.out, /dittfirma\.wybe\.me is now the default for new sessions/);
    const pin = await run(['use', 'andrefirma.wybe.me', '--session', 'sess-1']);
    assert.match(pin.out, /session sess-1 now uses andrefirma\.wybe\.me/);
    assert.match((await run(['list'])).out, /^\* dittfirma\.wybe\.me/m, 'pinning one session leaves the default');

    const bad = await run(['use', 'nope.wybe.me']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /no connection named nope\.wybe\.me/);

    const rm = await run(['remove', 'dittfirma.wybe.me']);
    assert.equal(rm.code, 0);
    assert.match(rm.out, /Removed dittfirma\.wybe\.me/);
    assert.match(rm.out, /revoke/i, 'says the pairing on the node stays until revoked');
    assert.match((await run(['list'])).out, /^\* andrefirma\.wybe\.me/m);
    assert.equal((await run(['remove', 'andrefirma.wybe.me'])).code, 0);
    assert.match((await run(['list'])).out, /No connections/);
  } finally {
    if (prev === undefined) delete process.env.WYBE_CONNECT_HOME;
    else process.env.WYBE_CONNECT_HOME = prev;
  }
});

test('runConnect: a second account on a connected node gets a connection of its own (<host>~<short hash>); list shows each account masked', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wybe-connect-cli-'));
  const prev = process.env.WYBE_CONNECT_HOME;
  process.env.WYBE_CONNECT_HOME = home;
  const hints = [];
  const fake = (token) => async (url, opts) => {
    hints.push(opts.harnessAccount ?? null);
    return { nodeUrl: url, mcpEndpoint: `${url}/mcp`, accessToken: token, refreshToken: null, scopes: opts.scopes, connectedAt: '2026-10-22T08:00:00.000Z', ...(opts.harnessAccount ? { harnessAccount: opts.harnessAccount } : {}) };
  };
  const run = async (argv, { account, connectImpl } = {}) => {
    const out = sink();
    const err = sink();
    const code = await runConnect({ harness: 'claude-code', clientName: 'x', argv, out, err, nextSteps: () => '', connectImpl, account });
    return { code, out: out.text, err: err.text };
  };
  try {
    assert.equal((await run(['https://dittfirma.wybe.me'], { account: 'jobb.konto@example.invalid', connectImpl: fake(TOKEN) })).code, 0);
    const second = await run(['https://dittfirma.wybe.me'], { account: 'privat@example.invalid', connectImpl: fake(`${TOKEN}2`) });
    assert.equal(second.code, 0, second.err);
    const derived = `dittfirma.wybe.me~${createHash('sha256').update('privat@example.invalid').digest('hex').slice(0, 8)}`;
    assert.match(second.out, /Also connected: dittfirma\.wybe\.me\./);
    assert.ok(second.out.includes(`${derived} is now the default`), second.out);
    assert.deepEqual(hints, ['jobb.konto@example.invalid', 'privat@example.invalid']);
    const jobb = JSON.parse(readFileSync(join(home, 'connections', 'dittfirma.wybe.me', 'credentials.json'), 'utf8'));
    assert.equal(jobb.accessToken, TOKEN, 'the first account\'s grant is kept');
    assert.equal(jobb.harnessAccount, 'jobb.konto@example.invalid');

    const list = await run(['list']);
    assert.equal(list.code, 0);
    assert.ok(list.out.includes(derived));
    assert.match(list.out, /^ +dittfirma\.wybe\.me +https:\/\/dittfirma\.wybe\.me .*account jo…@example\.invalid/m);
    assert.match(list.out, /^\* dittfirma\.wybe\.me~[0-9a-f]{8} +https:\/\/dittfirma\.wybe\.me .*account pr…@example\.invalid/m);
    assert.ok(!list.out.includes('jobb.konto') && !list.out.includes('privat@'), 'the full account is never printed');
  } finally {
    if (prev === undefined) delete process.env.WYBE_CONNECT_HOME;
    else process.env.WYBE_CONNECT_HOME = prev;
  }
});
