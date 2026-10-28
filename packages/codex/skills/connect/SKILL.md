---
name: connect
description: Connect this Codex to the person's Wybe AI colleague so that hooks feed it redacted session summaries and `remember` can store work facts. Triggers on a pasted sentence like "Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me", "Koble til Wybe", "Connect me to my Wybe AI colleague at https://dittfirma.wybe.me", "connect to Wybe", or any request to pair Codex with a Wybe address.
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
   `~/.wybe-connect/codex/credentials.json`, owner-only):
   ```
   node "<plugin root>/bin/connect.js" https://dittfirma.wybe.me
   ```
   A browser opens on `auth.wybe.me`; the person logs in with their passkey and ticks what to
   share (`remember`, `conversations`, `sessions:light`, `sessions:full`). Wait for
   `Connected to ...`. If it prints a URL instead of opening a browser, show that URL.
   Never read or echo `credentials.json`.

3. **Add the MCP server for the interactive tools** (`remember`, `import_conversation`,
   `pending_questions`), which use Codex's own OAuth sign-in:
   ```
   codex mcp add wybe --url https://dittfirma.wybe.me/mcp
   codex mcp login wybe
   ```

4. **Offer the standing line for `~/.codex/AGENTS.md`** (the plugin's `AGENTS.snippet.md`).
   The SessionStart hook already hands it to you each session; the AGENTS.md copy covers
   sessions where the hooks are not trusted yet. Append it only if the person agrees.

5. **Confirm** in one paragraph: connected to which address, which scopes, that the first sync
   is the colleague's import and starts by itself (no step for the person), that the hooks flush
   redacted session deltas at every stop and before compaction (and queue at session end), that
   Codex asks once to trust the hooks, and that the pairing can be revoked under "Mine
   koblinger" (revoking stops the flow; erasing what was learned is a separate action).

## Never

- Never read or print a credential file, a `wat_`/`wrt_` token, or an `Authorization` header.
- Never send anything personal, about other people, or any credential through `remember`.
  Work only ("kun jobb").
- Never claim anything can be read back from Wybe: the flow is one way.
