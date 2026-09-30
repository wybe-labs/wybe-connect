// The body of each package's bin/connect.js: parse `<node-url> [--scopes a,b]`, run the OAuth
// flow once under the harness's own client name, store the grant in that harness's home
// (lib/home.js harnessHome), and print where it connected, the granted scopes and the next steps.
// Never prints a token.

import { connect, ALL_SCOPES } from './oauth.js';
import { paths, harnessHome, saveCredentials } from './home.js';

export function parseConnectArgs(args) {
  let nodeUrl = null;
  let scopes = [...ALL_SCOPES];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scopes') scopes = String(args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (args[i] === '--help' || args[i] === '-h') return { help: true };
    else if (!nodeUrl) nodeUrl = args[i];
    else return { error: `unexpected argument: ${args[i]}` };
  }
  if (!nodeUrl) return { error: 'missing <node-url>' };
  const unknown = scopes.filter((s) => !ALL_SCOPES.includes(s));
  if (unknown.length) return { error: `unknown scope(s): ${unknown.join(', ')} (known: ${ALL_SCOPES.join(', ')})` };
  return { nodeUrl, scopes };
}

export async function runConnect({ harness, clientName, nextSteps, argv = process.argv.slice(2), out = process.stdout, err = process.stderr, connectImpl = connect }) {
  const parsed = parseConnectArgs(argv);
  if (parsed.help || parsed.error) {
    if (parsed.error) err.write(`${parsed.error}\n`);
    err.write('usage: connect.js <node-url> [--scopes remember,conversations,sessions:light,sessions:full]\n');
    return parsed.help ? 0 : 2;
  }
  try {
    const credentials = await connectImpl(parsed.nodeUrl, { scopes: parsed.scopes, clientName, log: (line) => err.write(`${line}\n`) });
    const p = paths(harnessHome(harness));
    saveCredentials(credentials, p);
    out.write(`Connected to ${credentials.nodeUrl}\n`);
    out.write(`Granted scopes: ${credentials.scopes.join(', ') || '(none)'}\n`);
    out.write(`Credential stored in ${p.credentials}\n`);
    out.write(nextSteps(credentials));
    return 0;
  } catch (e) {
    err.write(`connect failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
