// Stands in for `claude -p` (NOT claude). Behaves like the real CLI with an MCP server: it starts
// the server named by --mcp-config, initializes, asks tools/list, and can only call `remember` if
// the server LISTED it (a model cannot call a tool it was not given). It records what it saw in
// $FAKE_LOG and exits 0 either way (claude -p exits 0 when the model just says it could not send).
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
const list = await call(2, 'tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name);
let answer = null;
if (names.includes('remember')) {
  answer = (await call(3, 'tools/call', { name: 'remember', arguments: { items: [{ subject: 'project', text: 'Works on the connect plugin.' }], ...(importOf ? { import_of: importOf } : {}) } })).result;
}
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tools: names, calledRemember: answer !== null, answer })}\n`);
server.kill();
process.stdout.write(names.includes('remember') ? 'Sent 1 item.\n' : 'The wybe server has no remember tool; nothing was sent.\n');
process.exit(0);
