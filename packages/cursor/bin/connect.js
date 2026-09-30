#!/usr/bin/env node
// node connect.js <node-url> [--scopes remember,conversations,sessions:light,sessions:full]
// Runs the OAuth flow once as "wybe-connect (Cursor)" and stores the grant in
// ~/.wybe-connect/cursor/credentials.json (0600). Never prints a token.

import { runConnect } from '../lib/connect-cli.js';

process.exitCode = await runConnect({
  harness: 'cursor',
  clientName: 'wybe-connect (Cursor)',
  nextSteps: (c) => [
    'For the interactive tools (remember, import_conversation, pending_questions), add this to ~/.cursor/mcp.json',
    '(Cursor runs the sign-in itself the first time a tool is used):',
    `  { "mcpServers": { "wybe": { "url": "${c.mcpEndpoint}" } } }`,
    '',
  ].join('\n'),
});
