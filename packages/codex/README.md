# wybe-connect for Codex CLI (placeholder, track C3)

Not implemented yet. The plan (`assistants-connect.md`, C3) maps Codex CLI's lifecycle hooks
(Codex >= 0.150 ships twelve, declared in `hooks.json` or `[hooks]` in `config.toml`) onto the same
shared `lib/`:

| Purpose | Codex hook (to verify against the Codex docs at build time) |
|---|---|
| inject the standing instruction + cached open questions | session start |
| flush the transcript delta (`report_session`) | stop / turn end |
| flush before context is lost | `PreCompact` (and `PostCompact` to reset the cursor) |
| final flush | session end |

Plus an `AGENTS.md` snippet carrying the standing line, and the MCP server entry for `config.toml`.
Nothing here runs today.
