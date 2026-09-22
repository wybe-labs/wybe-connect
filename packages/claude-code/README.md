# wybe-connect for Claude Code

The plugin. Install from the marketplace at the root of this repository:

```
/plugin marketplace add wybe-labs/wybe-connect
/plugin install wybe-connect@wybe-connect
```

Then paste, with your own node address:

> Koble meg til Wybe-kollegaen min: https://<slug>.wybe.me

The `connect` skill takes it from there (see `skills/connect/SKILL.md`).

| Piece | What it does |
|---|---|
| `hooks/session-start.js` | hands Claude the standing "remember work facts" instruction and the node's cached open questions |
| `hooks/flush.js` | Stop / SessionEnd / PreCompact: transcript delta -> scope-aware payload -> redaction -> `report_session` (or the local queue) |
| `bin/connect.js` | the one-time OAuth flow; stores the grant in `~/.wybe-connect/credentials.json` |
| `lib/` | a byte-identical copy of the repository's `lib/` (Claude Code copies only this directory on install; `npm run sync-lib` refreshes it and a test guards it) |

What leaves your machine, per scope, is in the root `README.md`.
