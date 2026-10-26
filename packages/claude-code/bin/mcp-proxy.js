#!/usr/bin/env node
// The plugin's `wybe` MCP server (stdio), started by Claude Code from .mcp.json. See lib/mcp-proxy.js:
// one sign-in (the `connect` tool) serves both the hooks and the node's tools. Inside a background
// distil run (WYBE_CONNECT_DISTIL, set by lib/distil.js) it is the run's outbox instead. An import
// request in a node answer goes to the distil scheduler.

import { runStdio } from '../lib/mcp-proxy.js';
import { paths, harnessHome } from '../lib/home.js';
import { sessionPaths, NODE_ENV } from '../lib/connections.js';
import { DISTIL_ENV, requestImport, maybeRun, planPaths } from '../lib/distil.js';

const root = harnessHome('claude-code');
const run = process.env[DISTIL_ENV];
const distilRun = typeof run === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(run) ? run : null;
// A distil run's server works in exactly the connection the run was planned for (lib/distil.js
// sets WYBE_CONNECT_NODE to it). Otherwise: the connection WYBE_CONNECT_NODE names, else the
// default one; without any, a sign-in through `connect` lands in the single layout, which the
// next hook moves under its node.
const resolved = distilRun ? null : sessionPaths(root);
const p = distilRun ? planPaths({ connection: process.env[NODE_ENV] || null }, root) ?? paths(root) : resolved.connection ? resolved : paths(root);

runStdio({
  paths: p,
  clientName: 'wybe-connect (Claude Code)',
  distilRun,
  onImportRequest: (requestedAt) => {
    if (requestImport(p, requestedAt)) maybeRun({ paths: p });
  },
});
