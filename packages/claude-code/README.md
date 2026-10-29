# wybe-connect for Claude Code

The plugin. Install from the marketplace at the root of this repository:

```
/plugin marketplace add wybe-labs/wybe-connect
/plugin install wybe-connect@wybe-connect
```

Then paste, with your own node address:

> Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me

The `connect` skill takes it from there (see `skills/connect/SKILL.md`).

| Piece | What it does |
|---|---|
| `hooks/session-start.js` | hands Claude the standing "remember work facts" instruction, the node's cached open questions, and a background-distil problem once per kind |
| `hooks/flush.js` | Stop / SessionEnd / PreCompact: notes the session for the background distil and lets the scheduler start a run; sends nothing itself |
| `bin/distil-run.js` | the detached watchdog of one background distil: runs `claude -p` (read-only tools, ended at 30 min), then delivers the run's outbox to the node, exactly once (see the root README, "The background distil") |
| `.mcp.json` → `bin/mcp-proxy.js` | the plugin's `wybe` MCP server: `connect(node_url)` signs in once (same grant as the hooks), then the node's tools are forwarded with that grant, every argument redacted first. Inside a distil run it is the run's outbox. An «Importer» request in a node answer starts an import run |
| `bin/connect.js` | the same OAuth flow from a terminal; stores the grant in `~/.wybe-connect/credentials.json` |
| `lib/` | a byte-identical copy of the repository's `lib/` (Claude Code copies only this directory on install; `npm run sync-lib` refreshes it and a test guards it) |

What leaves your machine, per scope, is in the root `README.md`.
