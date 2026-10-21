# wybe-connect for Claude Code

The plugin. Install from the marketplace at the root of this repository:

```
claude plugin install wybe-connect --marketplace wybe-labs/wybe-connect
```

Then paste, with your own node address:

> Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me

The `connect` skill takes it from there (see `skills/connect/SKILL.md`).

| Piece | What it does |
|---|---|
| `hooks/session-start.js` | hands Claude the standing "remember work facts" instruction and the node's cached open questions |
| `hooks/flush.js` | Stop / SessionEnd / PreCompact: notes the session for the next distil run and starts it when due (at most every 6 h). Sends nothing itself |
| `skills/distil` + `lib/distil.js` | the background `claude -p` that reads local sessions and memory and sends only durable work facts with `remember` (ongoing, or all sources when you press «Importer» on your node) |
| `.mcp.json` → `bin/mcp-proxy.js` | the plugin's `wybe` MCP server: `connect(node_url)` signs in once (same grant as the hooks), then the node's tools are forwarded with that grant |
| `bin/connect.js` | the same OAuth flow from a terminal; stores the grant in `~/.wybe-connect/credentials.json` |
| `lib/` | a byte-identical copy of the repository's `lib/` (Claude Code copies only this directory on install; `npm run sync-lib` refreshes it and a test guards it) |

What leaves your machine, per scope, is in the root `README.md`.
