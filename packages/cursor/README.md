# wybe-connect for Cursor (placeholder, track C4)

Not implemented yet. The plan (`assistants-connect.md`, C4) maps Cursor's hooks in `.cursor/hooks.json`
onto the same shared `lib/`:

| Purpose | Cursor hook |
|---|---|
| record the person's prompt (light scope) | `beforeSubmitPrompt` |
| note files touched | `afterFileEdit` |
| flush the delta and surface open questions as a `followup_message` | `stop` |

Plus the MCP server entry for Cursor's `mcp.json`. Nothing here runs today.
