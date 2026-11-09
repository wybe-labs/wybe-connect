// Stands in for `claude -p` in the project-summary tests. It is never the real claude. Like the real
// CLI, it starts the `wybe` server named by --mcp-config (with that entry's env) and initializes.
// For each "Project <name>:" heading in the prompt it sends one summary item (subject: the name,
// category: insight), the last call carrying import_of in an import, then calls distil_done. Each
// summary carries an e-mail address, so the test can see that redaction still runs.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (!argv.includes('-p')) process.exit(0); // picked up by `node --test` as a file: nothing to do
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const importOf = /^import_of: (.+)$/m.exec(prompt)?.[1] ?? null;
const projects = [...prompt.matchAll(/^Project (.+):$/gm)].map((m) => m[1]);
const cfg = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
const s = cfg.mcpServers.wybe;
const server = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...(s.env ?? {}) }, windowsHide: true });
const rl = createInterface({ input: server.stdout });
const waiting = new Map();
rl.on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
let id = 0;
const call = (method, params) => new Promise((r) => { id += 1; waiting.set(id, r); server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });

await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
await call('tools/list', {});
for (const [i, name] of projects.entries()) {
  const last = i === projects.length - 1;
  const item = { subject: name, category: 'insight', content: `Project summary: ${name} is a service the person builds; questions go to ops@example.invalid.` };
  await call('tools/call', { name: 'remember', arguments: { items: [item], ...(last && importOf ? { import_of: importOf } : {}) } });
}
await call('tools/call', { name: 'distil_done', arguments: {} });
server.kill();
process.exit(0);
