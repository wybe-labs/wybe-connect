import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as oauth from '../lib/oauth.js';
import { createProxy } from '../lib/mcp-proxy.js';
import { paths } from '../lib/home.js';

// The authorization server refuses a dynamic client registration whose name claims Wybe. The one
// form it lets through is a trailing «<non-Wybe name> (wybe)», such as «Claude Code (wybe)». The
// static clients (STATIC_CLIENTS) never register, but a harness without a static row falls back
// to registration, and its client_name must pass that rule.
//
// The server's rule folds look-alike letters across scripts, which a copy here would only
// approximate. So this file does not re-implement it: it pins the exact names the code can send.
// Each one below was checked against the server's own rule and accepted. A new name fails this
// file until it has been checked against the server the same way and added here.

const SERVER_ACCEPTED_NAMES = Object.freeze(['Claude Code (wybe)', 'Codex (wybe)', 'Cursor (wybe)']);

const ROOT = join(import.meta.dirname, '..');
const HARNESSES = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

function assertServerAccepts(name, expectedDisplay) {
  assert.ok(SERVER_ACCEPTED_NAMES.includes(name), `${JSON.stringify(name)} is not one of the names checked against the server: ${SERVER_ACCEPTED_NAMES.join(', ')}`);
  if (expectedDisplay) assert.equal(name, `${expectedDisplay} (wybe)`);
}

test('the pinned names are plain ASCII «<harness> (wybe)» with no Wybe before the suffix', () => {
  for (const name of SERVER_ACCEPTED_NAMES) {
    // ASCII letters and single spaces only: no look-alike letters, digits or separators to fold.
    const m = /^([A-Za-z]+(?: [A-Za-z]+)*) \(wybe\)$/.exec(name);
    assert.ok(m, `${JSON.stringify(name)} is not plain-ASCII «<harness> (wybe)»`);
    assert.doesNotMatch(m[1].replace(/ /g, ''), /wybe/i, `${JSON.stringify(name)} names Wybe before the suffix`);
  }
});

test('the old fallback names and near misses are not accepted', () => {
  for (const name of ['wybe-connect (Claude Code)', 'wybe-connect (Codex)', 'wybe-connect (Cursor)', 'Wybe Code (wybe)', 'W.Y.B.E Code (wybe)', 'Claude Code (wybe) extra', 'Claude Code (wуbe)', 'Claude  Code (wybe)']) {
    assert.throws(() => assertServerAccepts(name), undefined, name);
  }
  assertServerAccepts('Claude Code (wybe)', 'Claude Code');
});

test('register: the default client_name is «Claude Code (wybe)»', async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ client_id: 'dcr_1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  await oauth.register({ metadata: { registration_endpoint: 'https://auth.example.invalid/oauth/register' }, redirectUri: 'http://127.0.0.1:1/cb', scopes: ['remember'], fetchImpl });
  assert.equal(body.client_name, 'Claude Code (wybe)');
  assertServerAccepts(body.client_name, 'Claude Code');
  assert.equal(oauth.DEFAULT_CLIENT_NAME, 'Claude Code (wybe)');
});

test('the MCP proxy hands connect the same default name', async () => {
  let seen = null;
  const proxy = createProxy({ paths: paths(mkdtempSync(join(tmpdir(), 'wybe-connect-dcr-name-'))), fetchImpl: async () => { throw new Error('no network expected'); }, connectImpl: (_url, opts) => { seen = opts.clientName; opts.onUrl('https://auth.example.invalid/oauth/authorize?state=s'); return new Promise(() => {}); } });
  await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect', arguments: { node_url: 'https://node.example.invalid' } } });
  assert.equal(seen, 'Claude Code (wybe)');
});

test('every harness entry point names its fallback client «<harness> (wybe)»', () => {
  let found = 0;
  for (const [harness, display] of Object.entries(HARNESSES)) {
    const binDir = join(ROOT, 'packages', harness, 'bin');
    for (const f of readdirSync(binDir).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(join(binDir, f), 'utf8');
      for (const [, name] of src.matchAll(/clientName:\s*'([^']*)'/g)) {
        assertServerAccepts(name, display);
        found += 1;
      }
    }
  }
  assert.ok(found >= 5, `found the entry points' client names (${found})`);
});

test('no shipped source holds a «… (wybe)» name outside the pinned list', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { if (entry !== 'node_modules') walk(p); } else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
    }
  };
  walk(join(ROOT, 'lib'));
  walk(join(ROOT, 'packages'));
  let found = 0;
  for (const file of files) {
    // Code literals only (single quotes or backticks); comments here quote with "…" or «…».
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/['`]([^'`\n]*\(\s*wybe\s*\))['`]/gi)) {
      assertServerAccepts(name);
      found += 1;
    }
  }
  assert.ok(found >= 9, `found the shipped client names (${found})`);
});
