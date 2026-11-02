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
| `hooks/session-start.js` | hands Claude the standing "remember work facts" instruction, the node's cached open questions, and a background-distil problem once per kind; fixes which connection the session uses and, when there are several, names it |
| `hooks/flush.js` | Stop / SessionEnd / PreCompact: notes the session for the background distil of the session's connection and lets the scheduler start a run; sends nothing itself |
| `bin/distil-run.js` | the detached watchdog of one background distil: runs `claude -p` (read-only tools, ended at 30 min), then delivers the run's outbox to its own connection's node, exactly once (see the root README, "The background distil") |
| `.mcp.json` → `bin/mcp-proxy.js` | the plugin's `wybe` MCP server: `connect(node_url)` signs in once (same grant as the hooks, stored as a connection), then the node's tools are forwarded with that grant, every argument redacted first. It uses the connection named by `WYBE_CONNECT_NODE`, else the default one. Inside a distil run it is the run's outbox. An «Importer» request in a node answer starts an import run |
| `hooks/task-wait.js` | the session bridge: an `asyncRewake` hook on SessionStart, Stop and StopFailure that reports the session (`sessions_report`), waits for a task from the person's Wybe colleague and wakes Claude with it (exit 2, the notice on stderr); Stop / StopFailure first send the running task's result (`task_result`). UserPromptSubmit pauses it; SessionEnd marks the session closed and hands the closing report to `bin/bridge.js`. See the root README, "Tasks from the colleague" |
| `take_task` (in `bin/mcp-proxy.js`) | a task that needs the person's yes: shows the exact text in an elicitation form (Godta / Avvis) and returns it only on accept; a decline sends `refused`. Without elicitation, it returns the text with the instruction to ask the person and wait for an explicit yes |
| `bin/connect.js` | the same OAuth flow from a terminal; stores the grant as a connection under `~/.wybe-connect/connections/<name>/`; also `list`, `use`, `remove` |
| `lib/` | a byte-identical copy of the repository's `lib/` (Claude Code copies only this directory on install; `npm run sync-lib` refreshes it and a test guards it) |

What leaves your machine, per scope, is in the root `README.md`.
