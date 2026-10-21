// Stands in for `claude -p` (NOT claude). Does what a distil run does with its one MCP server:
// starts the server named by --mcp-config, calls `remember` with the import_of from the -p prompt,
// records the server's answer in $FAKE_LOG, and exits 0 (claude -p exits 0 after a tool error too:
// the error is just a tool result the model reads).
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (!argv.includes('-p')) process.exit(0); // picked up by `node --test` as a file: nothing to do
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const importOf = /^import_of: (.+)$/m.exec(prompt)?.[1] ?? null;
const cfg = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
const s = cfg.mcpServers.wybe;
const server = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env, windowsHide: true });
const rl = createInterface({ input: server.stdout });
const waiting = new Map();
rl.on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
const call = (id, method, params) => new Promise((r) => { waiting.set(id, r); server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });

await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
const answer = await call(2, 'tools/call', { name: 'remember', arguments: { items: [{ subject: 'project', text: 'Works on the connect plugin.' }], ...(importOf ? { import_of: importOf } : {}) } });
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ importOf, answer: answer.result })}\n`);
server.kill();
process.stdout.write('Sent 0 items, answered 0 questions.\n');
process.exit(0);
