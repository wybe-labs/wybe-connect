import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { STANDING_INSTRUCTION } from '../lib/session-context.js';
import { pendingView } from '../lib/distil.js';
import { connectionPaths } from '../lib/connections.js';

// Spawns packages/codex/hooks/*.js with stdin shaped like
// codex-rs/hooks/schema/generated/*.command.input.schema.json (openai/codex @ 0462dcc0) against the
// synthetic rollouts in test/fixtures. Not a live Codex run. The hooks send nothing themselves:
// they note the rollout for the background distil (test/codex-distil.test.js covers the run). A
// Stop may start a run, so every hook here gets WYBE_CONNECT_CODEX_BIN = the fake codex.

const ROOT = join(import.meta.dirname, '..');
const PKG = join(ROOT, 'packages', 'codex');
const HOOKS = join(PKG, 'hooks');
const FIX = join(import.meta.dirname, 'fixtures');
const FAKE_CODEX = join(FIX, 'fake-codex.mjs');
const TOKEN = ['wat_', 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');
const REFUSED = 'http://127.0.0.1:9';
const SID = '0190c0de-0000-7000-8000-00000000c0de';
const ROLLOUT_NAME = `rollout-2026-09-22T09-00-00-${SID}.jsonl`;

function runHook(script, input, home, args = []) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, WYBE_CONNECT_HOME: home, WYBE_CONNECT_CODEX_BIN: FAKE_CODEX, CODEX_HOME: join(home, '..', 'codex-home') };
    delete env.WYBE_CONNECT_DISTIL;
    const child = spawn(process.execPath, [join(HOOKS, script), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function sandbox(fixture = 'codex-rollout.jsonl') {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-codex-'));
  const home = join(dir, 'home');
  const project = join(dir, 'atlas-demo');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.git', 'config'), '[remote "origin"]\n\turl = https://example.com/x.git\n');
  const rollout = join(dir, ROLLOUT_NAME);
  copyFileSync(join(FIX, fixture), rollout);
  return { dir, home, codexHome: join(home, 'codex'), project, rollout };
}

/** The one connection these tests use, in the layout of lib/connections.js. */
const conn = (dir) => join(dir, 'connections', 'node');
/** Every rollout waiting for the distil of that connection: notes on disk and those folded into its state. */
const notesOf = (codexHome) => (existsSync(conn(codexHome)) ? pendingView(connectionPaths(codexHome, 'node')) : []);

function writeCredentials(dir, endpointBase, scopes) {
  mkdirSync(conn(dir), { recursive: true });
  writeFileSync(join(conn(dir), 'credentials.json'), JSON.stringify({
    version: 1, nodeUrl: endpointBase, mcpEndpoint: `${endpointBase}/mcp`, issuer: REFUSED, tokenEndpoint: `${REFUSED}/oauth/token`,
    clientId: 'c-codex', accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes,
  }));
}

/** A recent failure: the back-off keeps a Stop from starting a run, so a test sees the note alone. */
function holdRuns(codexHome) {
  const at = new Date().toISOString();
  writeFileSync(join(conn(codexHome), 'distil.json'), JSON.stringify({ version: 2, lastFailureAt: at, lastError: { class: 'node-unreachable', message: 'x', at } }));
}

const stopInput = (rollout, project, extra = {}) => ({
  session_id: SID, transcript_path: rollout, cwd: project, hook_event_name: 'Stop', model: 'gpt-5.5-codex',
  permission_mode: 'default', turn_id: 'turn-2', stop_hook_active: false, last_assistant_message: 'Capped at five retries.', ...extra,
});

function fakeNodeServer() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, body });
      res.writeHead(500).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

test('codex Stop: sends nothing, queues no rollout delta, and notes the rollout for the background distil', async () => {
  const { home, codexHome, project, rollout } = sandbox();
  const node = await fakeNodeServer();
  try {
    writeCredentials(codexHome, node.base, ['remember', 'sessions:full']);
    holdRuns(codexHome);
    const r = await runHook('flush.js', stopInput(rollout, project), home);
    assert.deepEqual(r, { code: 0, stdout: '', stderr: '' }, 'Codex parses stdout as hook output: the hook prints nothing');
    assert.deepEqual(node.seen, [], 'not a single request: nothing raw leaves');
    assert.equal(existsSync(join(conn(codexHome), 'queue')), false);
    assert.equal(existsSync(join(conn(home), 'queue')), false, 'Claude Code\'s home is not touched');
    const notes = notesOf(codexHome);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].path, rollout);
    assert.equal(notes[0].sessionId, SID);
    assert.equal(notes[0].cwd, project);
  } finally {
    node.server.close();
  }
});

test('codex SessionStart hands over the cached open questions and the standing instruction, in Codex\'s output shape', async () => {
  const { home, codexHome, project, rollout } = sandbox();
  writeCredentials(codexHome, REFUSED, ['remember']);
  writeFileSync(join(conn(codexHome), 'open-questions.json'), JSON.stringify({ fetched_at: new Date().toISOString(), open_questions: [{ id: 'q-9', question: 'Hva bruker du Codex mest til?' }] }));
  const start = await runHook('session-start.js', { session_id: SID, transcript_path: rollout, cwd: project, hook_event_name: 'SessionStart', model: 'gpt-5.5-codex', permission_mode: 'default', source: 'startup' }, home);
  assert.equal(start.code, 0);
  assert.equal(start.stderr, '');
  const out = JSON.parse(start.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(STANDING_INSTRUCTION));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('(q-9) Hva bruker du Codex mest til?'));
  assert.ok(!out.hookSpecificOutput.additionalContext.includes(TOKEN));
});

test('codex SessionStart tells a background-distil problem once, in Codex\'s words', async () => {
  const { home, codexHome } = sandbox();
  writeCredentials(codexHome, REFUSED, ['remember']);
  const at = new Date().toISOString();
  writeFileSync(join(conn(codexHome), 'distil.json'), JSON.stringify({ version: 2, lastFailureAt: at, lastError: { class: 'codex-missing', message: 'codex was not found on this machine', at } }));
  const first = await runHook('session-start.js', { session_id: SID, hook_event_name: 'SessionStart' }, home);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /could not find the codex command/);
  const again = await runHook('session-start.js', { session_id: SID, hook_event_name: 'SessionStart' }, home);
  assert.doesNotMatch(JSON.parse(again.stdout).hookSpecificOutput.additionalContext, /codex command/, 'told once');
});

test('codex: a subagent rollout, a subagent PreCompact (agent_id), no credential and no remember scope note nothing', async () => {
  const sub = sandbox('codex-rollout-subagent.jsonl');
  writeCredentials(sub.codexHome, REFUSED, ['remember']);
  holdRuns(sub.codexHome);
  assert.deepEqual(await runHook('flush.js', stopInput(sub.rollout, sub.project), sub.home), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(notesOf(sub.codexHome), []);

  const main = sandbox();
  writeCredentials(main.codexHome, REFUSED, ['remember']);
  holdRuns(main.codexHome);
  const pre = await runHook('flush.js', { ...stopInput(main.rollout, main.project), hook_event_name: 'PreCompact', trigger: 'auto', agent_id: 'a-1', agent_type: 'reviewer' }, main.home);
  assert.deepEqual(pre, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(notesOf(main.codexHome), []);

  const none = sandbox();
  assert.deepEqual(await runHook('flush.js', stopInput(none.rollout, none.project), none.home), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await runHook('session-start.js', { hook_event_name: 'SessionStart' }, none.home), { code: 0, stdout: '', stderr: '' });

  const noScope = sandbox();
  writeCredentials(noScope.codexHome, REFUSED, ['sessions:full']);
  assert.deepEqual(await runHook('flush.js', stopInput(noScope.rollout, noScope.project), noScope.home), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(notesOf(noScope.codexHome), []);
  assert.equal(existsSync(join(conn(noScope.codexHome), 'queue')), false);

  const bad = await runHook('flush.js', '{not json', none.home);
  assert.equal(bad.code, 0);
  assert.match(bad.stderr, /^wybe-connect: flush failed: /);
});

test('codex hooks.json: exactly the four events, ${PLUGIN_ROOT} commands naming scripts that exist, SessionEnd within Codex\'s 3 s cap', () => {
  const hooks = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PreCompact', 'SessionEnd', 'SessionStart', 'Stop']);
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        assert.equal(h.type, 'command');
        const m = /^node "\$\{PLUGIN_ROOT\}\/(hooks\/[a-z-]+\.js)"( --offline)?$/.exec(h.command);
        assert.ok(m, `${event}: unexpected command ${h.command}`);
        assert.ok(existsSync(join(PKG, m[1])), `${event}: ${m[1]} missing`);
        assert.ok(Number.isInteger(h.timeout) && h.timeout > 0);
      }
    }
  }
  assert.ok(hooks.SessionEnd[0].hooks[0].timeout <= 3);
  assert.match(hooks.SessionEnd[0].hooks[0].command, /--offline$/);
});

test('codex plugin: manifest, marketplace listing, AGENTS.md snippet and the config.toml MCP entry', () => {
  const manifest = JSON.parse(readFileSync(join(PKG, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'wybe-connect');
  assert.equal(manifest.hooks, './hooks/hooks.json');
  assert.ok(existsSync(join(PKG, 'skills', 'connect', 'SKILL.md')));
  const market = JSON.parse(readFileSync(join(ROOT, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['wybe-connect', { source: 'local', path: './packages/codex' }]]);
  assert.ok(readFileSync(join(PKG, 'AGENTS.snippet.md'), 'utf8').includes(STANDING_INSTRUCTION), 'the AGENTS.md snippet carries the standing line verbatim');
  const toml = readFileSync(join(PKG, 'config.toml.snippet'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.wybe\]\ncommand = "node"\n/m);
  assert.doesNotMatch(toml, /^url = /m, 'the node\'s URL is not added as a second server with its own sign-in');
});
