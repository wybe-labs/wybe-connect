#!/usr/bin/env node
// node connect.js <node-url> [--scopes remember,conversations,sessions:light,sessions:full] [--name <name>]
// node connect.js list | use <name> [--session <id>] | remove <name>
// Runs the OAuth flow once and stores the grant as one connection under
// ~/.wybe-connect/connections/<name>/ (0600), next to any others. Never prints a token.

import { runConnect } from '../lib/connect-cli.js';

process.exitCode = await runConnect({
  harness: 'claude-code',
  clientName: 'wybe-connect (Claude Code)',
  nextSteps: (c, { key, others }) => [
    'For the interactive tools, add the server to Claude Code:',
    `  claude mcp add --transport http ${others.length ? `wybe-${key.replace(/[^A-Za-z0-9_-]/g, '-')}` : 'wybe'} ${c.mcpEndpoint}`,
    '',
  ].join('\n'),
});
