#!/usr/bin/env node
// The plugin's `wybe` MCP server (stdio), started by Claude Code from .mcp.json. See lib/mcp-proxy.js:
// one sign-in (the `connect` tool) serves both the hooks and the node's tools.

import { runStdio } from '../lib/mcp-proxy.js';
import { paths, harnessHome } from '../lib/home.js';

runStdio({ paths: paths(harnessHome('claude-code')), clientName: 'wybe-connect (Claude Code)' });
