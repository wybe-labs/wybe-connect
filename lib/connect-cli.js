// The body of each package's bin/connect.js:
//   <node-url> [--scopes a,b] [--name n]   run the OAuth flow once under the harness's own client
//                                          name and store the grant as a connection of its own in
//                                          that harness's home (lib/connections.js); it becomes the
//                                          default for new sessions. A second node never replaces
//                                          the first; the same node again replaces its grant.
//   list                                   the connections, the default marked *
//   use <name> [--session <id>]            the default for new sessions, or one session's connection
//   remove <name>                          delete a connection's local grant and queue
// Prints where it connected, the granted scopes and the next steps. Never prints a token.

import { connect, ALL_SCOPES } from './oauth.js';
import { harnessHome } from './home.js';
import { connectionPaths, listConnections, saveConnection, useConnection, removeConnection, checkedName, NODE_ENV } from './connections.js';

const USAGE = [
  'usage: connect.js <node-url> [--scopes remember,conversations,sessions:light,sessions:full] [--name <name>]',
  '       connect.js list',
  '       connect.js use <name> [--session <session-id>]',
  '       connect.js remove <name>',
  '',
].join('\n');

const COMMANDS = ['list', 'use', 'remove'];

function parseCommand(args) {
  const [command, ...rest] = args;
  if (command === 'list') return rest.length ? { error: `unexpected argument: ${rest[0]}` } : { command };
  let ref = null;
  let sessionId = null;
  for (let i = 0; i < rest.length; i++) {
    if (command === 'use' && rest[i] === '--session') sessionId = rest[++i] ?? null;
    else if (!ref) ref = rest[i];
    else return { error: `unexpected argument: ${rest[i]}` };
  }
  if (!ref) return { error: 'missing <name>' };
  if (command === 'use' && rest.includes('--session') && !sessionId) return { error: 'missing <session-id>' };
  return command === 'use' ? { command, ref, sessionId } : { command, ref };
}

export function parseConnectArgs(args) {
  if (COMMANDS.includes(args[0])) return parseCommand(args);
  let nodeUrl = null;
  let name = null;
  let scopes = [...ALL_SCOPES];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scopes') scopes = String(args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (args[i] === '--name') name = String(args[++i] ?? '');
    else if (args[i] === '--help' || args[i] === '-h') return { help: true };
    else if (!nodeUrl) nodeUrl = args[i];
    else return { error: `unexpected argument: ${args[i]}` };
  }
  if (!nodeUrl) return { error: 'missing <node-url>' };
  const unknown = scopes.filter((s) => !ALL_SCOPES.includes(s));
  if (unknown.length) return { error: `unknown scope(s): ${unknown.join(', ')} (known: ${ALL_SCOPES.join(', ')})` };
  if (name === null) return { nodeUrl, scopes };
  try {
    return { nodeUrl, scopes, name: checkedName(name) }; // refused before the browser opens, not after
  } catch (e) {
    return { error: e.message };
  }
}

function printList(root, out) {
  const list = listConnections(root);
  if (!list.length) {
    out.write('No connections. Connect with: connect.js <node-url>\n');
    return;
  }
  const w = Math.max(...list.map((c) => c.key.length));
  const u = Math.max(...list.map((c) => c.nodeUrl.length));
  for (const c of list) {
    const extra = [c.connectedAt ? `connected ${c.connectedAt.slice(0, 10)}` : null, c.queued ? `${c.queued} queued` : null].filter(Boolean).join(', ');
    out.write(`${c.isDefault ? '*' : ' '} ${c.key.padEnd(w)}  ${c.nodeUrl.padEnd(u)}  ${c.scopes.join(', ') || '(no scopes)'}${extra ? `  (${extra})` : ''}\n`);
  }
  out.write(`* = the default for new sessions. Choose another per session with ${NODE_ENV}=<name> or: connect.js use <name> --session <session-id>\n`);
}

export async function runConnect({ harness, clientName, nextSteps, argv = process.argv.slice(2), out = process.stdout, err = process.stderr, connectImpl = connect }) {
  const parsed = parseConnectArgs(argv);
  if (parsed.help || parsed.error) {
    if (parsed.error) err.write(`${parsed.error}\n`);
    err.write(USAGE);
    return parsed.help ? 0 : 2;
  }
  const root = harnessHome(harness);
  try {
    if (parsed.command === 'list') {
      printList(root, out);
      return 0;
    }
    if (parsed.command === 'use') {
      const key = useConnection(root, parsed.ref, { sessionId: parsed.sessionId });
      out.write(parsed.sessionId ? `From its next hook, session ${parsed.sessionId} now uses ${key}.\n` : `${key} is now the default for new sessions.\n`);
      return 0;
    }
    if (parsed.command === 'remove') {
      const { key, dropped } = removeConnection(root, parsed.ref);
      out.write(`Removed ${key}${dropped ? ` and ${dropped} queued payload(s) not yet sent` : ''}.\n`);
      out.write('The pairing on the node stays until you revoke it there (the Wybe portal\'s list of connected assistants).\n');
      return 0;
    }
    const credentials = await connectImpl(parsed.nodeUrl, { scopes: parsed.scopes, clientName, log: (line) => err.write(`${line}\n`) });
    const key = saveConnection(root, credentials, { name: parsed.name ?? null });
    const others = listConnections(root).filter((c) => c.key !== key).map((c) => c.key);
    out.write(`Connected to ${credentials.nodeUrl}\n`);
    out.write(`Granted scopes: ${credentials.scopes.join(', ') || '(none)'}\n`);
    out.write(`Credential stored in ${connectionPaths(root, key).credentials}\n`);
    if (others.length) {
      out.write(`Also connected: ${others.join(', ')}. ${key} is now the default for new sessions; sessions already running keep theirs.\n`);
      out.write(`Choose per session with ${NODE_ENV}=<name> or: connect.js use <name> --session <session-id>; see all with: connect.js list\n`);
    }
    out.write(nextSteps(credentials, { key, others }));
    return 0;
  } catch (e) {
    err.write(`${parsed.command ?? 'connect'} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
