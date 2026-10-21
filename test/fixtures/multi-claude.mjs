// Stands in for `claude -p` (NOT claude). Does what SKILL.md tells a distil run to do when it splits
// its list: several `remember` calls through the plugin's own MCP server (from --mcp-config), with
// `import_of` only in the LAST one (import mode). It does not retry a failed call, records every
// answer in $FAKE_LOG, and exits 0 (claude -p exits 0 after a tool error: it is just a tool result).
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (!argv.includes('-p')) process.exit(0); // picked up by `node --test` as a file: nothing to do
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const importOf = /^import_of: (.+)$/m.exec(prompt)?.[1] ?? null;
const calls = Number(process.env.FAKE_CALLS ?? 3);
const cfg = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
const s = cfg.mcpServers.wybe;
const server = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env, windowsHide: true });
const rl = createInterface({ input: server.stdout });
const waiting = new Map();
rl.on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
const call = (id, method, params) => new Promise((r) => { waiting.set(id, r); server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });

await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
for (let i = 0; i < calls; i++) {
  const last = i === calls - 1;
  const args = { items: [{ subject: 'project', text: `Fact batch ${i + 1} of ${calls}.` }], ...(last && importOf ? { import_of: importOf } : {}) };
  const answer = await call(2 + i, 'tools/call', { name: 'remember', arguments: args });
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ call: i + 1, importOf: args.import_of ?? null, answer: answer.result })}\n`);
}
server.kill();
process.stdout.write(`Sent ${calls} items, answered 0 questions.\n`);
process.exit(0);
