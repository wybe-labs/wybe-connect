import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    const stored = JSON.parse(readFileSync(join(home, 'cursor', 'credentials.json'), 'utf8'));
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
