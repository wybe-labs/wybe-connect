// Stands in for `codex exec` in the Codex distil tests. It is never the real codex. It plays an
// obedient headless run:
//   - it reads its MCP servers the way Codex layers config: the person's config.toml (here one
//     server named `person-server`), then every `-c key=value` override in order, a value parsed
//     as TOML (the subset these overrides use: a string, an array of strings, an inline table of
//     strings, an empty inline table);
//   - it starts the `wybe` server with only a few variables of its own environment plus that
//     server's `env` table, as Codex does for a stdio server;
//   - it reads the "- <path> lines a-b" ranges the prompt lists, and turns every line it read into
//     one fact "<file>#<line>": a fact stored twice means a line was distilled twice, and no fact
//     carries rollout text;
//   - it calls remember (import_of on the last call of an import) and then distil_done.
// Without --ephemeral it writes its own rollout under CODEX_HOME/sessions, as Codex would, so a
// test sees whether a distil run could become a session to import.
//   FAKE_LOG  appends one JSON line: argv flags, the servers it ended with, the tools it saw
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] !== 'exec') process.exit(0); // picked up by `node --test` as a file: nothing to do

const flags = new Set();
const overrides = [];
let prompt = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-c' || a === '--config') overrides.push(argv[++i]);
  else if (a === '--sandbox' || a === '-s') flags.add(`sandbox=${argv[++i]}`);
  else if (a.startsWith('-')) flags.add(a);
  else prompt = a;
}

function tomlValue(v) {
  const t = v.trim();
  if (t.startsWith('"') || t.startsWith('[')) return JSON.parse(t);
  if (t.startsWith('{')) {
    const out = {};
    for (const m of t.slice(1, -1).matchAll(/([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")/g)) out[m[1]] = JSON.parse(m[2]);
    return out;
  }
  throw new Error(`not TOML this fake understands: ${v}`);
}

const config = { mcp_servers: { 'person-server': { command: 'person-server-binary', args: [] } } };
for (const o of overrides) {
  const eq = o.indexOf('=');
  const path = o.slice(0, eq).split('.');
  let at = config;
  for (const k of path.slice(0, -1)) at = at[k] && typeof at[k] === 'object' ? at[k] : (at[k] = {});
  at[path[path.length - 1]] = tomlValue(o.slice(eq + 1));
}

const s = config.mcp_servers.wybe_distil;
const keep = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const server = spawn(s.command, s.args ?? [], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...keep, ...(s.env ?? {}) }, windowsHide: true });
const rl = createInterface({ input: server.stdout });
const waiting = new Map();
rl.on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
let id = 0;
const call = (method, params) => new Promise((r) => { id += 1; waiting.set(id, r); server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });

const importOf = /^import_of: (.+)$/m.exec(prompt ?? '')?.[1] ?? null;
const facts = [];
for (const m of (prompt ?? '').matchAll(/^- (.+\.jsonl) lines (\d+)-(\d+)$/gm)) {
  const lines = readFileSync(m[1], 'utf8').split('\n');
  for (let i = Number(m[2]); i <= Number(m[3]); i++) if (lines[i - 1] !== undefined) facts.push(`${basename(m[1])}#${i}`);
}
if (importOf && !facts.length) facts.push('import: nothing new');

await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '0' } });
const tools = ((await call('tools/list', {})).result?.tools ?? []).map((t) => t.name);
for (let i = 0; i < facts.length; i += 50) {
  const last = i + 50 >= facts.length;
  const items = facts.slice(i, i + 50).map((content) => ({ content, subject: 'project' }));
  await call('tools/call', { name: 'remember', arguments: { items, ...(last && importOf ? { import_of: importOf } : {}) } });
}
await call('tools/call', { name: 'distil_done', arguments: {} });
server.kill();

if (!flags.has('--ephemeral') && process.env.CODEX_HOME) {
  const dir = join(process.env.CODEX_HOME, 'sessions', '2026', '10', '25');
  mkdirSync(dir, { recursive: true });
  const rid = `0190ffff-0000-7000-8000-${String(Date.now() % 1e12).padStart(12, '0')}`;
  writeFileSync(join(dir, `rollout-2026-10-25T10-00-00-${rid}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: rid, cwd: process.cwd(), source: 'exec' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: prompt } }),
    '',
  ].join('\n'));
}
if (process.env.FAKE_LOG) {
  appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ flags: [...flags], servers: Object.keys(config.mcp_servers), tools, facts: facts.length, importOf, cwd: process.cwd(), env: { distil: s.env?.WYBE_CONNECT_DISTIL ?? null } })}\n`);
}
process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
process.exit(0);
