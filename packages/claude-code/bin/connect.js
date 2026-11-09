#!/usr/bin/env node
// node connect.js <node-url> [--scopes remember,conversations,sessions:light,sessions:full] [--name <name>]
// node connect.js list | use <name> [--session <id>] | remove <name>
// Runs the OAuth flow once and stores the grant as one connection under
// ~/.wybe-connect/connections/<name>/ (0600), next to any others. Never prints a token. The
// plugin's `connect` tool (lib/mcp-proxy.js) does the same from inside Claude Code.

import { runConnect } from '../lib/connect-cli.js';
import { NODE_ENV } from '../lib/connections.js';

process.exitCode = await runConnect({
  harness: 'claude-code',
  clientName: 'wybe-connect (Claude Code)',
  nextSteps: (_c, { key, others }) => [
    others.length
      ? `The plugin's \`wybe\` MCP server uses the default connection (now ${key}), or the one ${NODE_ENV}=<name> names when Claude Code starts; restart Claude Code to load the tools.`
      : 'The plugin\'s `wybe` MCP server uses this same grant; restart Claude Code to load the tools.',
    '',
  ].join('\n'),
});
