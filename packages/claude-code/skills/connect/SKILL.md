---
name: connect
description: Connect this Claude Code to the person's Wybe colleague (their Wybe node) so that it receives the essence of their work (durable facts distilled and redacted on this machine) and `remember` can store work facts. Triggers on a pasted sentence like "Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me", "Koble meg til Wybe-kollegaen min: https://<slug>.wybe.me", "Koble til Wybe", "Connect me to my Wybe colleague at https://<slug>.wybe.me", "connect to Wybe", "wybe connect", or any request to pair, link or hook up Claude Code with a Wybe node URL.
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

2. **Make sure the plugin is installed.** Its `wybe` MCP server offers a `connect` tool. If you
   do not have it, tell the person to run, in a terminal:
   ```
   claude plugin install wybe-connect --marketplace wybe-labs/wybe-connect
   ```
   and to start Claude Code again and paste the sentence once more.

3. **Sign in once:** call the `wybe` server's `connect` tool with `node_url`. A browser opens on
   `auth.wybe.me`; the person signs in with their passkey and approves `remember` (durable work facts;
   that is all this plugin sends). If the answer carries a link
   because no browser appeared, show the link. When the person says they are done, call
   `connect` again: it answers `Connected to ...` with the granted scopes. That one sign-in
   serves the hooks and the tools; there is nothing else to add or copy.
   Never paste, read or echo `~/.wybe-connect/credentials.json`.

4. **First sync: the opening kit.** Ask the person, in their language, for the short version
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

5. **Confirm** in one paragraph: connected to which node, which scopes, that from now on only the
   essence is sent (a background distil on this machine, at most every 6 hours, redacted; never
   transcripts), that «Importer» in their Wybe portal distils their local history once, and that pairing can be revoked
   under "Mine koblinger" on the node (revoking stops the flow; erasing what was learned is a
   separate action there).

## Never

- Never read or print `~/.wybe-connect/credentials.json`, a `wat_`/`wrt_` token, or an
  `Authorization` header.
- Never send anything personal, about other people, or any credential through `remember`.
  Work only ("kun jobb").
- Never claim the node can be asked for anything back: the flow is one way.
