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

Like the Claude Code plugin, this one sends the **essence** of your work, never raw sessions: a
background distil on your machine (a headless `codex exec`) turns your sessions into short,
redacted `remember` facts and delivers each exactly once. On first connect it imports your Codex
sessions of the last 30 days by itself. The pipeline and its guarantees are described in the
repository README ("The background distil"); this page lists what is Codex's own.

| Piece | What it does |
|---|---|
| `mcp.json` | the plugin's own `wybe` MCP server: `node ${PLUGIN_ROOT}/bin/mcp-proxy.js` over stdio |
| `bin/mcp-proxy.js` | before you connect it offers `connect(node_url)`; after, the node's own tools, forwarded with the plugin's grant (no second sign-in). Inside a distil run it is the run's outbox. It picks up the node's import request (2 s after start, every 5 min, and at once after a sign-in) |
| `bin/distil-run.js` | the detached watchdog: runs `codex exec`, ends it at 30 min, delivers the outbox |
| `hooks/hooks.json` | `SessionStart` -> `session-start.js`; `Stop` and `PreCompact` -> `flush.js`; `SessionEnd` -> `flush.js --offline` |
| `hooks/session-start.js` | hands the model the standing "remember work facts" line, the cached open questions and a background-distil problem, once per kind (`hookSpecificOutput.additionalContext`) |
| `hooks/flush.js` | notes the session's rollout for the distil of the connection the session uses, and lets the scheduler start a run when one is due. Sends nothing itself |
| `bin/connect.js` | the one-time OAuth flow as client `wybe-connect (Codex)`; stores the grant as a connection under `~/.wybe-connect/codex/connections/<name>/`; also `list`, `use`, `remove` |
| `AGENTS.snippet.md` | the standing line for `~/.codex/AGENTS.md`, for sessions where the hooks are not trusted yet |
| `config.toml.snippet` | the manual fallback for `mcp.json`: `[mcp_servers.wybe] command = "node", args = [".../bin/mcp-proxy.js"]` |
| `lib/` | a byte-identical copy of the repository's `lib/` (`npm run sync-lib`; a test guards it) |

`mcp.json` uses the portable MCP format Codex plugins take at the plugin root, where each server
names its transport `type`. The documentation shows `streamable-http`; `stdio` is that format's
name for a local command server. If an installed Codex does not start the server from
`mcp.json`, add the `config.toml.snippet` entry by hand.

## How the Codex events map

| Codex event | Why |
|---|---|
| `SessionStart` | standing instruction, cached open questions and a distil problem, as `additionalContext` |
| `Stop` | fires at the end of every root turn (spawned subagents get `SubagentStop`, which is not registered): notes the rollout, ticks the scheduler |
| `PreCompact` | notes before the context is compacted; a subagent's (with `agent_id`) is ignored |
| `SessionEnd` | Codex caps it at 3 s, so it only notes; the next `Stop` starts the run |

## The headless run

```
codex exec --sandbox read-only --json --ephemeral --skip-git-repo-check
  -c mcp_servers={}
  -c mcp_servers.wybe_distil.command="<node>"
  -c mcp_servers.wybe_distil.args=["<plugin>/bin/mcp-proxy.js"]
  -c mcp_servers.wybe_distil.env={ WYBE_CONNECT_DISTIL = "<run>", WYBE_CONNECT_HOME = "<home>", WYBE_CONNECT_NODE = "<connection>" }
  "<prompt>"
```

- `--sandbox read-only`: the model can read the rollout ranges with a shell command and change nothing.
- `--ephemeral`: the run writes no rollout, so it is never a session to import.
- `-c mcp_servers={}` first: every MCP server you configured is dropped for the run; the
  plugin's own server, in distil mode and named `wybe_distil` (never confused with the
  interactive `wybe`), is the only one. Its distil mode travels in the server's
  `env` table, since Codex starts a stdio server with only a few variables of its own environment.
- It runs in the distil's own folder under `~/.wybe-connect/codex/connections/<name>/distil/`,
  so no project's `AGENTS.md` or `.codex/config.toml` applies to it. JSON events go to the run's log
  there (owner-only, kept 14 days).
- `codex` is found as `codex(.exe)` on PATH, or on Windows as the npm shim's
  `node_modules/@openai/codex/bin/codex.js` under Node. `WYBE_CONNECT_CODEX_BIN` overrides it.

## What is read, and what never leaves

The run reads only the line ranges of the rollouts the plugin lists: noted by the hooks, or for
the import every rollout under `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl`
changed in the last 30 days, each from where the last run for that node stopped. The import also
reads `~/.codex/AGENTS.md` and the projects' `AGENTS.md`. A rollout whose `session_meta.source`
is a subagent or an internal job is not the person's thread and is never read; nor is a
distil run's own thread, nor a compressed (`.zst`) rollout. What leaves is only the facts the
model chose, redacted again on this machine by `lib/redact.js`.

## Verified against

- Hook events, `hooks.json` format, stdin fields, output shape: https://learn.chatgpt.com/docs/hooks
  (redirected from developers.openai.com/codex/hooks), read 2026-09-29; and the generated schemas
  in `openai/codex` `codex-rs/hooks/schema/generated/` at commit `0462dcc0` (2026-09-29).
- `transcript_path` = the rollout path; Stop vs SubagentStop; SessionEnd 1 s default / 3 s cap;
  `${PLUGIN_ROOT}` substitution in hook commands; `hooks/hooks.json` default; marketplace lookup
  order; `codex plugin marketplace add` / `codex plugin add`: the same commit
  (`core/src/session/mod.rs`, `core/src/hook_runtime.rs`, `hooks/src/events/session_end.rs`,
  `hooks/src/engine/discovery.rs`, `core-plugins/src/{loader,marketplace}.rs`,
  `cli/src/{marketplace,plugin}_cmd.rs`).
- Rollout record shapes: `rollout/src/policy.rs` and `protocol/src/protocol.rs` at that commit, plus
  a structural census (key paths and value types only, no content) of real rollouts written by the
  Codex desktop app 0.153.4 to 0.155.0-alpha.
- `codex exec` flags `--sandbox read-only`, `--json`, `--ephemeral`, `--skip-git-repo-check`,
  `-c key=value`: https://learn.chatgpt.com/docs/developer-commands?surface=cli. A stdio server in
  config.toml (`[mcp_servers.<name>] command, args, env`):
  https://learn.chatgpt.com/docs/extend/mcp?surface=cli. Plugin `mcp.json` at the plugin root with
  a transport `type` per server: https://developers.openai.com/codex/plugins/build.

**Not verified:** a live run in the Codex CLI. The tests spawn the hook scripts and the plugin's
MCP server with schema-shaped input against synthetic rollouts, and the distil with a fake
`codex` that plays an obedient `codex exec` (it parses the `-c` overrides as TOML and starts the
server with only the `env` table). Not checked against a real Codex: that `${PLUGIN_ROOT}` is
expanded in `mcp.json` args; that `-c mcp_servers={}` followed by `mcp_servers.wybe_distil.*` leaves
only `wybe` (overrides applied in order); that a plugin's own `mcp.json` server is not also
started inside the run; how `codex exec` approves MCP tool calls without a person; the CLI's
legacy history mode on real files.
