#!/usr/bin/env node
// The plugin's `wybe` MCP server (stdio), started by Codex from the plugin's mcp.json (or from the
// config.toml entry in config.toml.snippet). See lib/mcp-proxy.js: one sign-in (the `connect` tool,
// or bin/connect.js) serves both the hooks and the node's tools. It uses the connection
// WYBE_CONNECT_NODE names, else the default one (lib/connections.js). Inside a background distil
// run (WYBE_CONNECT_DISTIL, set by lib/distil.js in the server's env table) it is the run's outbox
// instead, in exactly the connection the run was planned for. An import request in a node answer
// goes to that connection's distil scheduler, which runs the import with `codex exec`.

import { runStdio } from '../lib/mcp-proxy.js';
import { STATIC_CLIENTS } from '../lib/oauth.js';
import { harnessHome } from '../lib/home.js';
import { NODE_ENV } from '../lib/connections.js';
import { DISTIL_ENV, requestImport, maybeRun, planPaths } from '../lib/distil.js';

const root = harnessHome('codex');
const run = process.env[DISTIL_ENV];
const distilRun = typeof run === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(run) ? run : null;

runStdio({
  ...(distilRun ? { paths: planPaths({ connection: process.env[NODE_ENV] || null }, root) } : { root }),
  clientId: STATIC_CLIENTS.codex,
  clientName: 'wybe-connect (Codex)',
  distilRun,
  onImportRequest: (requestedAt, p) => {
    if (p && requestImport(p, requestedAt)) maybeRun({ paths: p, harness: 'codex' });
  },
});
