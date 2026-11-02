// The first real distil, against a real node: opt-in, skipped unless WYBE_CONNECT_LIVE_NODE is set.
// It never signs in or runs claude itself; it checks what a real run left on this machine.
//   1. A fresh sandbox: CLAUDE_CONFIG_DIR=<dir>/claude, WYBE_CONNECT_HOME=<dir>/wybe-connect.
//   2. node test/live/seed.mjs "$CLAUDE_CONFIG_DIR"
//   3. Sign in to Claude Code in that sandbox, install the plugin from this checkout, and connect
//      to the staging node. The node asks for the import, and the real `claude -p` distils it.
//   4. When the import is delivered: WYBE_CONNECT_LIVE_NODE=<connection name> node --test test/live/
// Only the local distil.json is read here. What the node stored (and that none of the seed's
// planted values is among it) is checked on the node's side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const name = process.env.WYBE_CONNECT_LIVE_NODE;
const skip = name ? false : 'set WYBE_CONNECT_LIVE_NODE (with WYBE_CONNECT_HOME and CLAUDE_CONFIG_DIR) to check a live distil';

test('a live import read every seeded session, the 60-day-old one too, and the memory files, and the node took all of it', { skip }, async () => {
  const PKG = join(import.meta.dirname, '..', '..', 'packages', 'claude-code');
  const lib = (f) => import(pathToFileURL(join(PKG, 'lib', f)).href);
  const D = await lib('distil.js');
  const C = await lib('connections.js');
  const { homePath, readJson } = await lib('home.js');
  const claudeHome = D.claudeHomeOf();
  const seed = readJson(join(claudeHome, 'live-seed.json'));
  assert.ok(seed, `no live-seed.json in ${claudeHome}: run test/live/seed.mjs first`);
  const p = C.connectionPaths(homePath(), C.checkedName(name));
  assert.ok(existsSync(p.credentials), `no connection ${name} under ${homePath()}`);
  const s = D.loadState(p);
  const node = D.nodeOf(readJson(p.credentials));

  assert.ok(s.importHandled, 'the node asked for an import, and it was handled');
  assert.equal(s.importRequest, null, 'no import is still waiting');
  assert.ok(s.lastSuccessAt, 'a run was delivered');
  assert.equal(s.lastError, null, `no problem is left: ${JSON.stringify(s.lastError)}`);
  assert.equal(s.outbox, null, 'nothing waits to be sent');
  assert.deepEqual(s.parked ?? [], []);
  assert.equal(s.running, null);
  assert.equal(s.setAside?.refused ?? 0, 0, 'the node refused nothing');
  assert.equal(s.setAside?.torn ?? 0, 0);
  for (const t of seed.seeded) {
    assert.equal(D.markOf(s, node, t.transcript), t.lines, `${t.project} (${t.ageDays} days old) was read to its end`);
  }
  const read = s.memoryMarks?.[node] ?? {};
  for (const f of seed.memory) assert.ok(read[f], `${f} was read`);
  const raw = readFileSync(D.distilPaths(p).state, 'utf8');
  for (const planted of seed.planted) assert.ok(!raw.includes(planted), 'no planted value is kept in the state');
});
