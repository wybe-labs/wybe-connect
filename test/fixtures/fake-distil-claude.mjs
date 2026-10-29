// Stands in for `claude -p` in the distil tests. It is never the real claude. Like the real CLI, it
// starts the `wybe` server named by --mcp-config (with that entry's env), initializes and asks
// tools/list. A model can call only what is listed, so this does too. It acts per environment:
//   FAKE_CALLS  remember calls to make (default 1), each one item "Fact <i> of <n>."; in import
//               mode the last one carries import_of from the prompt
//   FAKE_ITEM   JSON merged into every item (e.g. a category or subject a model might pick)
//   FAKE_ANSWERS JSON list passed as answers on the first remember call
//   FAKE_DONE   '0' skips distil_done at the end (a run that dies or forgets to finish)
//   FAKE_EXIT   the exit code (default 0: claude -p exits 0 after a tool error too)
//   FAKE_LOG    appends one JSON line: the tools it saw, every answer, the flags it got, its cwd, the --settings file's content
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

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

await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
const tools = ((await call('tools/list', {})).result?.tools ?? []).map((t) => t.name);
const answers = [];
const calls = Number(process.env.FAKE_CALLS ?? 1);
if (tools.includes('remember')) {
  for (let i = 0; i < calls; i++) {
    const last = i === calls - 1;
    const item = { content: `Fact ${i + 1} of ${calls}.`, subject: 'project', ...JSON.parse(process.env.FAKE_ITEM ?? '{}') };
    const args = { items: [item], ...(i === 0 && process.env.FAKE_ANSWERS ? { answers: JSON.parse(process.env.FAKE_ANSWERS) } : {}), ...(last && importOf ? { import_of: importOf } : {}) };
    answers.push((await call('tools/call', { name: 'remember', arguments: args })).result);
  }
}
if (process.env.FAKE_DONE !== '0' && tools.includes('distil_done')) answers.push((await call('tools/call', { name: 'distil_done', arguments: {} })).result);
if (process.env.FAKE_LOG) {
  const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tools, answers, importOf, flags: { tools: flag('--tools'), allowedTools: flag('--allowedTools'), permissionMode: flag('--permission-mode'), maxTurns: flag('--max-turns'), strict: argv.includes('--strict-mcp-config'), settingSources: flag('--setting-sources'), settings: flag('--settings') }, cwd: process.cwd(), settingsFile: flag('--settings') && existsSync(flag('--settings')) ? readFileSync(flag('--settings'), 'utf8') : null, env: { distil: process.env.WYBE_CONNECT_DISTIL ?? null } })}\n`);
}
server.kill();
process.stdout.write(`Sent ${calls} call(s).\n`);
process.exit(Number(process.env.FAKE_EXIT ?? 0));
