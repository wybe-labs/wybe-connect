#!/usr/bin/env node
// The plugin's `wybe` MCP server (stdio), started by Claude Code from .mcp.json. See lib/mcp-proxy.js:
// one sign-in (the `connect` tool) serves both the hooks and the node's tools. Inside a background
// distil run (WYBE_CONNECT_DISTIL, set by lib/distil.js) it is the run's outbox instead. An import
// request in a node answer goes to the distil scheduler.

import { runStdio } from '../lib/mcp-proxy.js';
import { paths, harnessHome } from '../lib/home.js';
import { DISTIL_ENV, requestImport, maybeRun } from '../lib/distil.js';

const p = paths(harnessHome('claude-code'));
const run = process.env[DISTIL_ENV];
const distilRun = typeof run === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(run) ? run : null;

runStdio({
  paths: p,
  clientName: 'wybe-connect (Claude Code)',
  distilRun,
  onImportRequest: (requestedAt) => {
    if (requestImport(p, requestedAt)) maybeRun({ paths: p });
  },
});
