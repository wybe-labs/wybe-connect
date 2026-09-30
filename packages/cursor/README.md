# wybe-connect for Cursor

A Cursor plugin (`.cursor-plugin/plugin.json`; the repository root lists it in
`.cursor-plugin/marketplace.json`). Install it from Cursor's plugin view (Customize), then paste,
with your own address:

> Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me

The `connect` skill takes it from there (`skills/connect/SKILL.md`).

Without the plugin system, copy `hooks.user.example.json` to `~/.cursor/hooks.json` (merge with
what is there), replacing `/ABSOLUTE/PATH/TO/wybe-connect` with where you cloned this repository,
and run `node packages/cursor/bin/connect.js https://dittfirma.wybe.me` yourself.

| Piece | What it does |
|---|---|
| `hooks/hooks.json` | seven Cursor hooks, all running `hooks/on-event.js` (it dispatches on `hook_event_name`) |
| `hooks/on-event.js` | `sessionStart` -> standing line + cached open questions as `additional_context`; `beforeSubmitPrompt`, `afterFileEdit`, `afterAgentResponse`, `postToolUse` -> one redacted spool record; `stop` -> flush, then maybe a `followup_message`; `sessionEnd` -> flush into the local queue |
| `bin/connect.js` | the one-time OAuth flow as client `wybe-connect (Cursor)`; stores the grant in `~/.wybe-connect/cursor/credentials.json` |
| `mcp.json.snippet` | the `wybe` entry for `~/.cursor/mcp.json`, for the interactive tools |
| `lib/` | a byte-identical copy of the repository's `lib/` (`npm run sync-lib`; a test guards it) |

## Why a spool and not the transcript

Cursor passes `transcript_path` only when transcripts are enabled, and does not document the
file's format. The hook payloads are documented, so the adapter builds the session from them
(`lib/cursor-spool.js`): each hook appends one record to
`~/.wybe-connect/cursor/spool/<conversation>.jsonl`, **redacted before it is written**, and `stop`
turns the spool into one `report_session`.

| Hook | Recorded | Scope |
|---|---|---|
| `beforeSubmitPrompt` | your prompt | `sessions:light` and `sessions:full` |
| `afterFileEdit` | the file path (never the edit) | both |
| `afterAgentResponse` | the agent's reply | `sessions:full` only: under light it is never written to disk at all |
| `postToolUse` | tool name, input, output (clipped to 4000 characters) | `sessions:full` only |
| `afterAgentThought` | not registered: thinking never leaves | none |

A spool whose conversation never reached a `stop` is deleted after 7 days.

## The followup guard

Cursor submits a `stop` hook's `followup_message` as the **next user message**. So an open
question is only put to the person when the turn `status` is `completed` and `loop_count` is 0
(never after a followup), at most one question per stop, never the same question twice within 14
days, and `loop_limit` is 1 in `hooks.json`. The followup starts with `[wybe-connect]`, and
`beforeSubmitPrompt` never records a prompt that starts with that marker as yours.

## Verified against

https://cursor.com/docs/agent/hooks (hook names, common and per-hook input, `stop` output and
`loop_limit`, `sessionStart` `additional_context`, `transcript_path` only when transcripts are
enabled), https://cursor.com/docs/reference/plugins (plugin manifest, `hooks/hooks.json`,
`${CURSOR_PLUGIN_ROOT}`, marketplace file) and https://cursor.com/docs/context/mcp (`mcp.json`
`url` entries), all read 2026-09-29.

**Not verified:** a live run in Cursor (the tests spawn `on-event.js` with doc-shaped stdin);
whether a `followup_message` also fires `beforeSubmitPrompt` (guarded by the marker either way);
whether hooks fire inside Cursor subagents (their replies could then reach a `sessions:full`
payload); whether the plugin loader accepts `"version": 1` in a plugin's `hooks/hooks.json` (the
standalone format requires it, the plugin reference's example omits it).
