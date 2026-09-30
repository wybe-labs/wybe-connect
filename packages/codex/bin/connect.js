#!/usr/bin/env node
// node connect.js <node-url> [--scopes remember,conversations,sessions:light,sessions:full]
// Runs the OAuth flow once as "wybe-connect (Codex)" and stores the grant in
// ~/.wybe-connect/codex/credentials.json (0600). Never prints a token.

import { runConnect } from '../lib/connect-cli.js';

process.exitCode = await runConnect({
  harness: 'codex',
  clientName: 'wybe-connect (Codex)',
  nextSteps: (c) => [
    'For the interactive tools (remember, import_conversation, pending_questions), add the MCP server to Codex:',
    `  codex mcp add wybe --url ${c.mcpEndpoint}`,
    '  codex mcp login wybe',
    'Codex runs a plugin\'s hooks only after you have reviewed and trusted them once; do that when Codex asks.',
    '',
  ].join('\n'),
});
