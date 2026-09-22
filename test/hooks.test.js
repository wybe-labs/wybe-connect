import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, existsSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionScopeOf, transcriptIdOf } from '../lib/flush.js';
import { STANDING_INSTRUCTION } from '../lib/session-context.js';

const ROOT = join(import.meta.dirname, '..');
const HOOKS = join(ROOT, 'packages', 'claude-code', 'hooks');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'session.jsonl');
const TOKEN = ['wat_', 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm'].join('');
const REFUSED = 'http://127.0.0.1:9';

function runHook(script, input, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HOOKS, script)], { env: { ...process.env, WYBE_CONNECT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'wybe-connect-hooks-'));
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.git', 'config'), '[remote "origin"]\n\turl = https://example.com/x.git\n');
  const transcript = join(dir, '11111111-2222-4333-8444-555555555555.jsonl');
  copyFileSync(FIXTURE, transcript);
  return { dir, home, project, transcript };
}

function writeCredentials(home, endpointBase, scopes) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({
    version: 1, nodeUrl: endpointBase, mcpEndpoint: `${endpointBase}/mcp`, issuer: REFUSED, tokenEndpoint: `${REFUSED}/oauth/token`,
    clientId: 'c1', accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes,
  }));
}

/** A minimal fake node speaking just enough Streamable HTTP for the poster. */
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
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { open_questions: [{ id: 'q-7', text: 'Hva bruker du Claude Code mest til?' }] } } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

test('sessionScopeOf prefers full, then light, else null; transcriptIdOf strips the extension', () => {
  assert.equal(sessionScopeOf(['remember', 'sessions:light', 'sessions:full']), 'sessions:full');
  assert.equal(sessionScopeOf(['sessions:light']), 'sessions:light');
  assert.equal(sessionScopeOf(['remember', 'conversations']), null);
  assert.equal(transcriptIdOf('/x/y/abc-123.jsonl'), 'abc-123');
  assert.equal(transcriptIdOf('C:\\x\\we ird.jsonl'), 'we_ird');
});

test('flush hook: unreachable node -> exit 0, one stderr line without the token, cursor advanced, delta queued and redacted', async () => {
  const { home, project, transcript } = sandbox();
  writeCredentials(home, REFUSED, ['remember', 'sessions:light']);
  const r = await runHook('flush.js', { session_id: 'sess', transcript_path: transcript, cwd: project, hook_event_name: 'Stop' }, home);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.match(r.stderr, /node not reachable \(network\); 1 delta\(s\) queued locally/);
  assert.ok(!r.stderr.includes(TOKEN));

  const cursor = JSON.parse(readFileSync(join(home, 'state', '11111111-2222-4333-8444-555555555555.json'), 'utf8'));
  assert.equal(cursor.byteOffset, statSync(transcript).size);
  assert.equal(cursor.seq, 1);

  const queued = readdirSync(join(home, 'queue'));
  assert.equal(queued.length, 1);
  const payload = JSON.parse(readFileSync(join(home, 'queue', queued[0]), 'utf8'));
  assert.equal(payload.scope, 'sessions:light');
  assert.deepEqual(payload.project, { name: 'project', git_remotes: ['origin'], branch: 'feat/retry' });
  assert.deepEqual(payload.delta, { seq: 1, event: 'Stop', byte_from: 0, byte_to: statSync(transcript).size, restarted: false });
  const s = JSON.stringify(payload);
  assert.ok(!s.includes('PLANTED-ASSISTANT-SENTENCE'), 'assistant text in a light payload');
  assert.ok(!s.includes('Pl4nted-Pw'), 'the planted DSN password left unredacted');
  assert.ok(s.includes('[REDACTED:url-userinfo]'));
  assert.deepEqual(payload.redaction, { families: [{ family: 'url-userinfo', count: 1 }] });

  const again = await runHook('flush.js', { session_id: 'sess', transcript_path: transcript, cwd: project, hook_event_name: 'PreCompact' }, home);
  assert.equal(again.code, 0);
  assert.equal(readdirSync(join(home, 'queue')).length, 1, 'nothing new to build, the queued item stays');
  assert.equal(JSON.parse(readFileSync(join(home, 'state', '11111111-2222-4333-8444-555555555555.json'), 'utf8')).seq, 1);
});

test('flush hook: once the node answers, the new delta is sent and the queue drains; open questions are cached', async () => {
  const { home, project, transcript } = sandbox();
  writeCredentials(home, REFUSED, ['sessions:full']);
  const first = await runHook('flush.js', { session_id: 'sess', transcript_path: transcript, cwd: project, hook_event_name: 'Stop' }, home);
  assert.equal(first.code, 0);
  assert.equal(readdirSync(join(home, 'queue')).length, 1);

  const node = await fakeNodeServer();
  try {
    writeCredentials(home, node.base, ['sessions:full']);
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u-9', timestamp: '2026-09-22T09:10:00.000Z', cwd: project, sessionId: 'sess', gitBranch: 'feat/retry', message: { role: 'user', content: 'And write the changelog line.' } })}\n`);
    const r = await runHook('flush.js', { session_id: 'sess', transcript_path: transcript, cwd: project, hook_event_name: 'SessionEnd' }, home);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.equal(readdirSync(join(home, 'queue')).length, 0, 'the queue drained');
    const calls = node.seen.filter((c) => c.rpc === 'tools/call');
    assert.equal(calls.length, 2);
    for (const c of node.seen) assert.equal(c.auth, `Bearer ${TOKEN}`);
    assert.equal(calls[0].params.name, 'report_session');
    assert.equal(calls[0].params.arguments.session.delta.seq, 2, 'the fresh delta goes first');
    assert.equal(calls[0].params.arguments.session.prompts.at(-1).text, 'And write the changelog line.');
    assert.equal(calls[1].params.arguments.session.delta.seq, 1, 'then the queued one');
    assert.ok(JSON.stringify(calls[1].params.arguments.session).includes('PLANTED-ASSISTANT-SENTENCE'), 'sessions:full carries assistant text');
    const cached = JSON.parse(readFileSync(join(home, 'state', 'open-questions.json'), 'utf8'));
    assert.deepEqual(cached.open_questions, [{ id: 'q-7', text: 'Hva bruker du Claude Code mest til?' }]);

    const start = await runHook('session-start.js', { session_id: 'sess2', hook_event_name: 'SessionStart', source: 'startup' }, home);
    assert.equal(start.code, 0);
    assert.equal(start.stderr, '');
    const out = JSON.parse(start.stdout);
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(out.hookSpecificOutput.additionalContext.includes(STANDING_INSTRUCTION));
    assert.ok(out.hookSpecificOutput.additionalContext.includes('(q-7) Hva bruker du Claude Code mest til?'));
    assert.ok(!out.hookSpecificOutput.additionalContext.includes(TOKEN));
  } finally {
    node.server.close();
  }
});

test('hooks without a credential do nothing and exit 0; malformed stdin exits 0 with one stderr line', async () => {
  const { home, project, transcript } = sandbox();
  const f = await runHook('flush.js', { session_id: 's', transcript_path: transcript, cwd: project, hook_event_name: 'Stop' }, home);
  assert.deepEqual(f, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(home, 'queue')), false);
  const s = await runHook('session-start.js', { hook_event_name: 'SessionStart' }, home);
  assert.deepEqual(s, { code: 0, stdout: '', stderr: '' });
  const bad = await runHook('flush.js', '{not json', home);
  assert.equal(bad.code, 0);
  assert.match(bad.stderr, /^wybe-connect: flush failed: /);
  assert.equal(bad.stderr.trim().split('\n').length, 1);
});

test('a grant without a sessions scope never builds or sends anything', async () => {
  const { home, project, transcript } = sandbox();
  writeCredentials(home, REFUSED, ['remember']);
  const r = await runHook('flush.js', { session_id: 's', transcript_path: transcript, cwd: project, hook_event_name: 'Stop' }, home);
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(join(home, 'queue')), false);
  assert.equal(existsSync(join(home, 'state')), false);
});
