# wybe-connect for Codex

A Codex plugin. Install from the marketplace at the root of this repository (Codex reads
`.agents/plugins/marketplace.json` there, before the Claude Code listing):

```
codex plugin marketplace add wybe-labs/wybe-connect
codex plugin add wybe-connect@wybe-connect
```

Then paste, with your own address:

> Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me

The `connect` skill takes it from there (`skills/connect/SKILL.md`). Codex runs a plugin's hooks
only after you have reviewed and trusted them once.

| Piece | What it does |
|---|---|
| `hooks/hooks.json` | `SessionStart` -> `session-start.js`; `Stop` and `PreCompact` -> `flush.js`; `SessionEnd` -> `flush.js --offline` |
| `hooks/session-start.js` | hands the model the standing "remember work facts" line and the cached open questions (`hookSpecificOutput.additionalContext`) |
| `hooks/flush.js` | rollout delta -> scope-aware payload (`lib/codex-rollout.js` + `lib/transcript.js`) -> redaction -> `report_session`, or the local queue |
| `bin/connect.js` | the one-time OAuth flow as client `wybe-connect (Codex)`; stores the grant in `~/.wybe-connect/codex/credentials.json` |
| `AGENTS.snippet.md` | the standing line for `~/.codex/AGENTS.md`, for sessions where the hooks are not trusted yet |
| `config.toml.snippet` | the MCP entry (`[mcp_servers.wybe] url = ...`) for the interactive tools; then `codex mcp login wybe` |
| `lib/` | a byte-identical copy of the repository's `lib/` (`npm run sync-lib`; a test guards it) |

## How the Codex events map

| Codex event | Why |
|---|---|
| `SessionStart` | standing instruction + cached open questions, as `additionalContext` |
| `Stop` | fires at the end of every root turn (spawned subagents get `SubagentStop`, which is not registered) |
| `PreCompact` | flush before the context is compacted; a subagent's (with `agent_id`) is ignored |
| `SessionEnd` | Codex caps it at 3 s, so it only queues; the next `Stop` sends |

`PostCompact` is not needed: a rollout is append-only, compaction adds a `compacted` line, and the
cursor is a byte offset per rollout file.

## What is read, and what never leaves

The hooks read the rollout Codex names in `transcript_path`. The person's prompts are taken from
`event_msg` records (`user_message` in legacy history mode, `item_completed` UserMessage in
paginated mode), never from the model-side `response_item` user messages, which also carry
`AGENTS.md` and `<environment_context>`. Wrapping the desktop app and IDE extension put around a
prompt (`<in-app-browser-context>`, automation heartbeats, the attached-files header) is stripped.
Developer messages, reasoning, inter-agent messages, compaction history and the
`repository_url` in `session_meta` never leave under any scope. A rollout whose `session_meta.source`
is a subagent or an internal job is not the person's thread and is never reported. Compressed
(`.zst`) rollouts are skipped.

## Verified against

- Hook events, `hooks.json` format, stdin fields, output shape: https://learn.chatgpt.com/docs/hooks
  (redirected from developers.openai.com/codex/hooks), read 2026-09-29; and the generated schemas
  in `openai/codex` `codex-rs/hooks/schema/generated/` at commit `0462dcc0` (2026-09-29).
- `transcript_path` = the rollout path; Stop vs SubagentStop; SessionEnd 1 s default / 3 s cap;
  `${PLUGIN_ROOT}` substitution; `hooks/hooks.json` default; marketplace lookup order;
  `codex plugin marketplace add` / `codex plugin add`: the same commit (`core/src/session/mod.rs`,
  `core/src/hook_runtime.rs`, `hooks/src/events/session_end.rs`, `hooks/src/engine/discovery.rs`,
  `core-plugins/src/{loader,marketplace}.rs`, `cli/src/{marketplace,plugin}_cmd.rs`).
- Rollout record shapes: `rollout/src/policy.rs` and `protocol/src/protocol.rs` at that commit, plus
  a structural census (key paths and value types only, no content) of real rollouts written by the
  Codex desktop app 0.153.4 to 0.155.0-alpha.
- MCP entry and `codex mcp add/login`: https://learn.chatgpt.com/docs/extend/mcp?surface=cli, read
  2026-09-29. `~/.codex/AGENTS.md`: https://learn.chatgpt.com/docs/agent-configuration/agents-md,
  read 2026-09-29.

**Not verified:** a live run in the Codex CLI (the tests spawn the hook scripts with
schema-shaped stdin against synthetic rollouts); the CLI's legacy history mode on real files (only
the desktop app's paginated mode was seen); whether compaction can start a new rollout file (the
per-file cursor is safe either way).
