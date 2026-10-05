import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { STANDING_INSTRUCTION } from '../lib/session-context.js';

// Spawns packages/codex/hooks/*.js with stdin shaped like
// codex-rs/hooks/schema/generated/*.command.input.schema.json (openai/codex @ 0462dcc0) against the
// synthetic rollouts in test/fixtures. Not a live Codex run.

const ROOT = join(import.meta.dirname, '..');
const PKG = join(ROOT, 'packages', 'codex');
const HOOKS = join(PKG, 'hooks');
const FIX = join(import.meta.dirname, 'fixtures');
const TOKEN = ['wat_', 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');
const REFUSED = 'http://127.0.0.1:9';
const SID = '0190c0de-0000-7000-8000-00000000c0de';
const ROLLOUT_NAME = `rollout-2026-09-22T09-00-00-${SID}.jsonl`;

function runHook(script, input, home, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HOOKS, script), ...args], { env: { ...process.env, WYBE_CONNECT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
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

function writeCredentials(dir, endpointBase, scopes) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
    version: 1, nodeUrl: endpointBase, mcpEndpoint: `${endpointBase}/mcp`, issuer: REFUSED, tokenEndpoint: `${REFUSED}/oauth/token`,
    clientId: 'c-codex', accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes,
  }));
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
      const msg = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, auth: req.headers.authorization, rpc: msg?.method ?? null, params: msg?.params ?? null });
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      if (msg.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })); return; }
      if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { open_questions: [{ id: 'q-9', text: 'Hva bruker du Codex mest til?' }] } } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

test('codex Stop, node unreachable: exit 0, one stderr line, delta queued under the codex home only, light and redacted', async () => {
  const { home, codexHome, project, rollout } = sandbox();
  writeCredentials(codexHome, REFUSED, ['remember', 'sessions:light']);
  const r = await runHook('flush.js', stopInput(rollout, project), home);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', 'Codex parses stdout as hook output: a flush prints nothing there');
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.match(r.stderr, /node not reachable \(network\); 1 delta\(s\) queued locally/);
  assert.ok(!r.stderr.includes(TOKEN));
  assert.equal(existsSync(join(home, 'queue')), false, 'Claude Code\'s queue is not touched');

  const cursor = JSON.parse(readFileSync(join(codexHome, 'state', `rollout-2026-09-22T09-00-00-${SID}.json`), 'utf8'));
  assert.equal(cursor.byteOffset, statSync(rollout).size);
  const queued = readdirSync(join(codexHome, 'queue'));
  assert.equal(queued.length, 1);
  const payload = JSON.parse(readFileSync(join(codexHome, 'queue', queued[0]), 'utf8'));
  assert.equal(payload.harness, 'codex');
  assert.equal(payload.scope, 'sessions:light');
  assert.equal(payload.session_id, SID);
  assert.deepEqual(payload.project, { name: 'atlas-demo', git_remotes: ['origin'], branch: 'feat/retry' });
  assert.deepEqual(payload.delta, { seq: 1, event: 'Stop', byte_from: 0, byte_to: statSync(rollout).size, restarted: false });
  const s = JSON.stringify(payload);
  for (const needle of ['PLANTED-ASSISTANT-SENTENCE', 'PLANTED-TOOL-OUTPUT', 'PLANTED-THINKING', 'PLANTED-AGENTS-MD', 'PLANTED-ENV-CONTEXT', 'PLANTED-DEVELOPER', 'PLANTED-REMOTE-PW', 'Pl4nted-Pw']) {
    assert.ok(!s.includes(needle), `${needle} left the machine`);
  }
  assert.ok(s.includes('[REDACTED:url-userinfo]'));
  assert.deepEqual(payload.redaction, { families: [{ family: 'url-userinfo', count: 1 }] });
});

test('codex Stop with sessions:full against a node: sent, open questions cached, SessionStart hands them over', async () => {
  const { home, codexHome, project, rollout } = sandbox();
  const node = await fakeNodeServer();
  try {
    writeCredentials(codexHome, node.base, ['sessions:full']);
    const r = await runHook('flush.js', stopInput(rollout, project), home);
    assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
    const calls = node.seen.filter((c) => c.rpc === 'tools/call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.name, 'report_session');
    const session = calls[0].params.arguments.session;
    assert.equal(session.harness, 'codex');
    assert.ok(JSON.stringify(session).includes('PLANTED-ASSISTANT-SENTENCE'), 'POSITIVE CONTROL: sessions:full carries assistant text');
    assert.ok(!JSON.stringify(session).includes('PLANTED-THINKING'));
    for (const c of node.seen) assert.equal(c.auth, `Bearer ${TOKEN}`);
    const cached = JSON.parse(readFileSync(join(codexHome, 'state', 'open-questions.json'), 'utf8'));
    assert.deepEqual(cached.open_questions, [{ id: 'q-9', text: 'Hva bruker du Codex mest til?' }]);

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
  } finally {
    node.server.close();
  }
});

test('codex SessionEnd (--offline): queued without a single request, and the next Stop sends it', async () => {
  const { home, codexHome, project, rollout } = sandbox();
  const node = await fakeNodeServer();
  try {
    writeCredentials(codexHome, node.base, ['sessions:light']);
    const end = await runHook('flush.js', { session_id: SID, transcript_path: rollout, cwd: project, hook_event_name: 'SessionEnd', reason: 'other' }, home, ['--offline']);
    assert.deepEqual(end, { code: 0, stdout: '', stderr: '' });
    assert.equal(node.seen.length, 0, 'SessionEnd must not touch the network');
    assert.equal(readdirSync(join(codexHome, 'queue')).length, 1);
    const next = await runHook('flush.js', stopInput(rollout, project), home);
    assert.equal(next.code, 0);
    assert.equal(readdirSync(join(codexHome, 'queue')).length, 0, 'the queue drained');
    const calls = node.seen.filter((c) => c.rpc === 'tools/call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.arguments.session.delta.event, 'SessionEnd');
  } finally {
    node.server.close();
  }
});

test('codex: a subagent rollout, a subagent PreCompact (agent_id), no credential and no sessions scope all do nothing', async () => {
  const sub = sandbox('codex-rollout-subagent.jsonl');
  writeCredentials(sub.codexHome, REFUSED, ['sessions:full']);
  assert.deepEqual(await runHook('flush.js', stopInput(sub.rollout, sub.project), sub.home), { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(sub.codexHome, 'queue')), false);
  assert.equal(existsSync(join(sub.codexHome, 'state')), false);

  const main = sandbox();
  writeCredentials(main.codexHome, REFUSED, ['sessions:full']);
  const pre = await runHook('flush.js', { ...stopInput(main.rollout, main.project), hook_event_name: 'PreCompact', trigger: 'auto', agent_id: 'a-1', agent_type: 'reviewer' }, main.home);
  assert.deepEqual(pre, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(main.codexHome, 'queue')), false);

  const none = sandbox();
  assert.deepEqual(await runHook('flush.js', stopInput(none.rollout, none.project), none.home), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await runHook('session-start.js', { hook_event_name: 'SessionStart' }, none.home), { code: 0, stdout: '', stderr: '' });

  const noScope = sandbox();
  writeCredentials(noScope.codexHome, REFUSED, ['remember']);
  assert.deepEqual(await runHook('flush.js', stopInput(noScope.rollout, noScope.project), noScope.home), { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(noScope.codexHome, 'queue')), false);

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
  assert.match(toml, /^\[mcp_servers\.wybe\]\nurl = "https:\/\/dittfirma\.wybe\.me\/mcp"$/m);
});
