#!/usr/bin/env node
// node connect.js <node-url> [--scopes remember,conversations,sessions:light,sessions:full]
// Runs the OAuth flow once and stores the grant in ~/.wybe-connect/credentials.json (0600).
// Prints where it connected and which scopes were granted. Never prints a token.

import { connect, ALL_SCOPES } from '../lib/oauth.js';
import { paths, saveCredentials } from '../lib/home.js';

function usage(code) {
  process.stderr.write('usage: connect.js <node-url> [--scopes a,b,c]\n');
  process.exit(code);
}

const args = process.argv.slice(2);
let nodeUrl = null;
let scopes = [...ALL_SCOPES];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--scopes') {
    scopes = String(args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  } else if (args[i] === '--help' || args[i] === '-h') {
    usage(0);
  } else if (!nodeUrl) {
    nodeUrl = args[i];
  } else {
    usage(2);
  }
}
if (!nodeUrl) usage(2);
const unknown = scopes.filter((s) => !ALL_SCOPES.includes(s));
if (unknown.length) {
  process.stderr.write(`unknown scope(s): ${unknown.join(', ')} (known: ${ALL_SCOPES.join(', ')})\n`);
  process.exit(2);
}

try {
  const credentials = await connect(nodeUrl, { scopes, log: (line) => process.stderr.write(`${line}\n`) });
  const p = paths();
  saveCredentials(credentials, p);
  process.stdout.write(`Connected to ${credentials.nodeUrl}\n`);
  process.stdout.write(`Granted scopes: ${credentials.scopes.join(', ') || '(none)'}\n`);
  process.stdout.write(`Credential stored in ${p.credentials}\n`);
  process.stdout.write(`For the interactive tools, add the server to Claude Code:\n  claude mcp add --transport http wybe ${credentials.mcpEndpoint}\n`);
} catch (err) {
  process.stderr.write(`connect failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
