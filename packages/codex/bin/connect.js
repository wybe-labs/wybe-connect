#!/usr/bin/env node
// node connect.js <node-url> [--scopes remember,conversations,sessions:light,sessions:full]
// node connect.js list | use <name> [--session <id>] | remove <name>
// Runs the OAuth flow once as "wybe-connect (Codex)" and stores the grant as one connection in
// ~/.wybe-connect/codex/connections/<name>/ (0600), next to any others. Never prints a token. The
// plugin's `connect` tool (lib/mcp-proxy.js) does the same from inside Codex.

import { runConnect } from '../lib/connect-cli.js';

process.exitCode = await runConnect({
  harness: 'codex',
  clientName: 'wybe-connect (Codex)',
  nextSteps: () => [
    'The plugin\'s `wybe` MCP server uses this same grant for the interactive tools; restart Codex to load them.',
    'The first sync starts by itself: the colleague asks for an import, and the plugin distils your Codex sessions of the last 30 days in the background.',
    'Codex runs a plugin\'s hooks only after you have reviewed and trusted them once; do that when Codex asks.',
    '',
  ].join('\n'),
});
