---
name: connect
description: Connect this Codex to the person's Wybe AI colleague so that a background distil feeds it the redacted essence of their work and `remember` can store work facts. Triggers on a pasted sentence like "Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me", "Koble til Wybe", "Connect me to my Wybe AI colleague at https://dittfirma.wybe.me", "connect to Wybe", or any request to pair Codex with a Wybe address.
---

# Connect to Wybe (Codex)

The person pasted (or said) one of these, with their own address:

> Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me

> Connect me to my Wybe AI colleague at https://dittfirma.wybe.me

Your job: pair this machine with that address once. The first sync is not a step here: the
colleague asks for it by itself when the connection is made (an import request in its tool
answers), and its own instructions say how to answer it. Everything the
plugin sends afterwards is **write-only** (nothing is ever read back into Codex) and is
**redacted on this machine first**. Say that in one sentence before you start.

The plugin root is the directory two levels above this `SKILL.md` (it holds `bin/` and `hooks/`).

## Steps

1. **Take the address from the sentence.** It must be `https://<something>.wybe.me`. If there
   is none, ask: "Hvilken adresse har KI-kollegaen din i Wybe? (https://dittfirma.wybe.me)".

2. **Run the OAuth flow** (stores the credential the hooks use in
   `~/.wybe-connect/codex/connections/<node>/credentials.json`, owner-only):
   ```
   node "<plugin root>/bin/connect.js" https://dittfirma.wybe.me
   ```
   A browser opens on `auth.wybe.me`; the person logs in with their passkey and ticks what to
   share (`remember`, `conversations`, `sessions:light`, `sessions:full`). Wait for
   `Connected to ...`. If it prints a URL instead of opening a browser, show that URL.
   Never read or echo `credentials.json`.
   Connecting a second node (or a second account, with `--name <name>`) keeps the first: each
   is its own connection, and the newest becomes the default for new sessions. `connect.js list`
   shows them, `connect.js use <name>` changes the default, `connect.js use <name> --session <id>`
   moves one session, `connect.js remove <name>` deletes one locally.

   That one sign-in serves the hooks and the plugin's own `wybe` MCP server (its `mcp.json`):
   there is no MCP server to add and no second sign-in.

3. **Offer the standing line for `~/.codex/AGENTS.md`** (the plugin's `AGENTS.snippet.md`).
   The SessionStart hook already hands it to you each session; the AGENTS.md copy covers
   sessions where the hooks are not trusted yet. Append it only if the person agrees.

4. **Confirm** in one paragraph: connected to which address, and which scopes. Say that the
   first sync is the colleague's import and starts by itself in the background: the plugin
   distils this machine's Codex sessions of the last 30 days into short work facts with a
   headless `codex exec`, and nothing raw leaves the machine. There is no step for the person.
   From then on, the hooks note each session at every stop and the same distil runs at most every
   6 hours. The colleague's tools appear after Codex is restarted, Codex asks once to trust the
   hooks, and the pairing can be revoked under "Mine koblinger" (revoking stops the flow; erasing
   what was learned is a separate action).

## Never

- Never read or print a credential file, a `wat_`/`wrt_` token, or an `Authorization` header.
- Never send anything personal, about other people, or any credential through `remember`.
  Work only ("kun jobb").
- Never claim anything can be read back from Wybe: the flow is one way.
