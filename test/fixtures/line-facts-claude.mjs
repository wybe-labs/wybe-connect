// Stands in for `claude -p` in the at-most-once tests. It is never the real claude. It does what
// the distil prompt says, and turns every transcript line it reads into one fact named
// "<file>#<line>", so the same source line always gives the same fact: a fact stored twice means
// a line was distilled twice.
//   - it reads the listed "- <path> lines a-b" ranges;
//   - if the prompt tells it to read "the transcripts from the last N days under ~/.claude/projects/"
//     (what an import prompt once said), it reads every such transcript under FAKE_PROJECTS, which
//     stands in for ~/.claude/projects (a test never points it at a real home).
// It sends the facts through the run's own `wybe` server (from --mcp-config), import_of on the last
// call of an import, then distil_done.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';

const argv = process.argv.slice(2);
if (!argv.includes('-p')) process.exit(0); // picked up by `node --test` as a file: nothing to do
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const importOf = /^import_of: (.+)$/m.exec(prompt)?.[1] ?? null;
const cfg = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
const s = cfg.mcpServers.wybe;
const server = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...(s.env ?? {}) }, windowsHide: true });
const rl = createInterface({ input: server.stdout });
const waiting = new Map();
rl.on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
let id = 0;
const call = (method, params) => new Promise((r) => { id += 1; waiting.set(id, r); server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });

const facts = new Set();
for (const m of prompt.matchAll(/^- (.+\.jsonl) lines (\d+)-(\d+)$/gm)) {
  for (let i = Number(m[2]); i <= Number(m[3]); i++) facts.add(`${basename(m[1])}#${i}`);
}
const scan = /transcripts from the last (\d+) days under ~\/\.claude\/projects\//.exec(prompt);
if (scan && process.env.FAKE_PROJECTS) {
  const days = Number(scan[1]);
  for (const d of readdirSync(process.env.FAKE_PROJECTS)) {
    for (const f of readdirSync(join(process.env.FAKE_PROJECTS, d))) {
      const full = join(process.env.FAKE_PROJECTS, d, f);
      if (!f.endsWith('.jsonl') || Date.now() - statSync(full).mtimeMs > days * 864e5) continue;
      const lines = readFileSync(full, 'utf8').split('\n').filter((l) => l.length);
      if (lines[0]?.includes('wybe-connect distil run')) continue;
      lines.forEach((_, i) => facts.add(`${f}#${i + 1}`));
    }
  }
}
if (importOf && !facts.size) facts.add('import: nothing new');

await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'line-facts', version: '0' } });
await call('tools/list', {});
const all = [...facts];
for (let i = 0; i < all.length; i += 50) {
  const last = i + 50 >= all.length;
  const items = all.slice(i, i + 50).map((content) => ({ content, subject: 'project' }));
  await call('tools/call', { name: 'remember', arguments: { items, ...(last && importOf ? { import_of: importOf } : {}) } });
}
await call('tools/call', { name: 'distil_done', arguments: {} });
server.kill();
process.exit(0);
