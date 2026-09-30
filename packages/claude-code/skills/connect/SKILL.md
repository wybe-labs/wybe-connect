---
name: connect
description: Connect this Claude Code to the person's Wybe colleague (their Wybe node) so that hooks feed it redacted session summaries and `remember` can store work facts. Triggers on a pasted sentence like "Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me", "Koble meg til Wybe-kollegaen min: https://<slug>.wybe.me", "Koble til Wybe", "Connect me to my Wybe colleague at https://<slug>.wybe.me", "connect to Wybe", "wybe connect", or any request to pair, link or hook up Claude Code with a Wybe node URL.
---

# Connect to Wybe

The person pasted (or said) one of these, with their own node URL:

> Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me

> Connect me to my Wybe AI colleague at https://dittfirma.wybe.me

Your job: pair this machine with that node once, then run the first sync. Everything the
plugin sends afterwards is **write-only** (the node never reads this machine, Claude Code never
reads the node) and is **redacted on this machine first**. Say that in one sentence before you
start; the person is granting access to their work context and should hear what it means.

## Steps

1. **Take the node URL from the sentence.** It must be `https://<something>.wybe.me`. If there
   is no URL, ask for it: "Hvilken adresse har KI-kollegaen din i Wybe? (https://dittfirma.wybe.me)".

2. **Make sure the plugin is installed.** If `${CLAUDE_PLUGIN_ROOT}` is set, it already is (you
   are running from it). Otherwise tell the person to run, in Claude Code:
   ```
   /plugin marketplace add wybe-labs/wybe-connect
   /plugin install wybe-connect@wybe-connect
   ```
   and to paste the sentence again once the plugin is active.

3. **Run the OAuth flow** (this stores the credential the hooks use, in
   `~/.wybe-connect/credentials.json`, owner-only):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/connect.js" https://<slug>.wybe.me
   ```
   A browser window opens on `auth.wybe.me`; the person logs in with their passkey and ticks
   the scopes they want to share (`remember`, `conversations`, `sessions:light`,
   `sessions:full`). Wait for the command to print `Connected to ...`. If it prints an URL
   instead of opening a browser, show that URL to the person.
   Never paste, read or echo the contents of `credentials.json`.

4. **Add the MCP server for the interactive tools** (`remember`, `import_conversation`,
   `pending_questions`), which use Claude Code's own OAuth session:
   ```
   claude mcp add --transport http wybe https://<slug>.wybe.me/mcp
   ```
   Claude Code will drive its own consent the first time a tool is used.

5. **First sync: the opening kit.** Ask the person, in their language, for the short version
   of these six things **about their work only**, then call the `wybe` server's `remember` tool
   with one item per fact:
   - projects they are working on right now
   - how they like to work (arbeidsmåte)
   - the tools they use
   - ideas they are carrying around
   - research they are doing or following
   - recurring tasks
   If the answer to `remember` carries `open_questions`, ask the first one right away and pass
   the answer back with `answers: [<id>]`.

6. **Confirm** in one paragraph: connected to which node, which scopes, that the hooks now
   flush redacted session deltas at every stop/compaction/end, and that pairing can be revoked
   under "Mine koblinger" on the node (revoking stops the flow; erasing what was learned is a
   separate action there).

## Never

- Never read or print `~/.wybe-connect/credentials.json`, a `wat_`/`wrt_` token, or an
  `Authorization` header.
- Never send anything personal, about other people, or any credential through `remember`.
  Work only ("kun jobb").
- Never claim the node can be asked for anything back: the flow is one way.
