# wybe-connect

The public, MIT-licensed, dependency-free client side of **Andre KI-assistenter**: it lets a
person's coding harness (Claude Code, Codex, Cursor) feed their Wybe AI colleague (their Wybe
node), and carries the standing texts for assistants without hooks (Claude Desktop / claude.ai,
ChatGPT). Three promises, in order of importance:

1. **Only sends.** There is no tool, scope or code path by which the harness reads anything
   from the node. The node retrieves and acts on its own.
2. **Redacts on your machine first.** Credentials, connection strings, private keys, Norwegian
   national identity numbers and (by default) e-mail addresses are replaced with
   `[REDACTED:<family>]` before anything leaves the laptop. Pattern-based and deterministic; no
   model is involved in deciding what is a secret.
3. **You choose how much, once, on the consent screen.** The sharing degree is the set of OAuth
   scopes you tick at `auth.wybe.me`. A scope you did not tick never flows.

Install and pairing take one pasted sentence; see "Getting started".

## What leaves your machine, per scope

| Scope | Consent label (nb) | What flows | When |
|---|---|---|---|
| `remember` | Fakta og prosjekter | durable facts about your **work** that Claude decides to store: projects, decisions, preferences, tools. Claude is told "work only" every session. | when Claude calls the `remember` tool, typically at the end of a session |
| `conversations` | Samtalesammendrag | a title and a summary of a past chat, and its messages only if you ask for them | only when you explicitly ask Claude to import a conversation |
| `sessions:light` | Arbeidsøkter — hva du ba om | per session: project name (the folder name), the **names** of your git remotes (never their URLs), branch, files Claude wrote or edited, start/end time, and **your own prompts**. Zero assistant text, zero tool output, zero thinking. Prompts written by Claude to its own subagents are excluded; text a hook injected into your prompt is stripped. | automatically at every stop, before every context compaction, and at session end |
| `sessions:full` | Arbeidsøkter — alt innhold | everything in `sessions:light` plus Claude's replies and every tool call's input and output (each clipped to 4000 characters). Thinking blocks still never leave. | same as above |

With no `sessions:*` scope the hooks build nothing and send nothing. Every payload carries a
`redaction.families` count (which families hit, how often, never the values) so a review can
see the redactor working.

Everything is redacted before it is written anywhere, including the local queue.

### The redaction families

| Family | What it catches |
|---|---|
| `pem-private-key` | `-----BEGIN ... PRIVATE KEY-----` blocks, whole |
| `url-userinfo` | `scheme://user:password@host` in any URL or DSN (the scheme and host stay) |
| `bearer` | the value after `Bearer ` |
| `wybe-credential` | `wnc_` `wbt_` `wpc_` `wat_` `wrt_` `wac_` `wcl_` credentials |
| `openai-key` | `sk-...` and `sk-ant-...` keys |
| `aws-access-key`, `aws-secret` | `AKIA...` ids and the 40-character secret after an AWS secret label |
| `github-token` | `ghp_` `gho_` `ghu_` `ghs_` `ghr_` and `github_pat_` tokens |
| `slack-token` | `xox?-...` tokens |
| `jwt` | `eyJ...` three-part signed tokens |
| `generic-secret` | a 32+ character hex or base64url value after `token`, `secret`, `key`, `password`, `api_key`, `client_secret`, ... |
| `fodselsnummer` | Norwegian national identity numbers whose two mod-11 control digits verify (an ordinary 11-digit number is left alone) |
| `email` | e-mail addresses; `{ emails: false }` keeps them |

`test/redact-weaken.js` weakens each family in turn and demands the suite goes red, so a
family that stopped protecting cannot pass unnoticed.

### What never leaves, under any scope

Thinking blocks. Subagent threads. The contents of files Claude only read (light). Your git
remote URLs. Anything from other projects than the one the session ran in. The OAuth token
itself (it is sent as a header to your node, and to nothing else).

## Getting started (Claude Code)

In Claude Code:

```
/plugin marketplace add wybe-labs/wybe-connect
/plugin install wybe-connect@wybe-connect
```

Then paste one of these with your own node address:

> Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me

> Connect me to my Wybe AI colleague at https://dittfirma.wybe.me

Claude runs the `connect` skill: a browser opens on `auth.wybe.me`, you log in with your
passkey and tick the scopes, and Claude runs the first sync (the opening kit: projects, how you
work, tools, ideas, research, recurring tasks; work only). From then on the hooks do the rest.

Revoking the pairing (under "Mine koblinger" on your node) stops the flow. Erasing what the
node learned from this assistant is a separate, explicit action there. Both are stated on the
consent screen.

## Getting started (Codex)

```
codex plugin marketplace add wybe-labs/wybe-connect
codex plugin add wybe-connect@wybe-connect
```

Codex reads `.agents/plugins/marketplace.json` at the root of this repository (it looks there
before `.claude-plugin/`, so it never picks up the Claude Code hooks). Paste the same sentence;
the plugin's `connect` skill runs the OAuth flow as its own client, adds the MCP server with
`codex mcp add wybe --url https://dittfirma.wybe.me/mcp` and `codex mcp login wybe`, and offers
the standing line for `~/.codex/AGENTS.md`. Codex runs a plugin's hooks only after you have
trusted them once. Details and what was verified where: `packages/codex/README.md`.

## Getting started (Cursor)

Install the plugin listed in `.cursor-plugin/marketplace.json` from Cursor's plugin view (or copy
`packages/cursor/hooks.user.example.json` into `~/.cursor/hooks.json`), then paste the same
sentence. Cursor's transcript format is not documented, so the Cursor hooks build the session
from the documented hook payloads instead: each hook spools one redacted record, and `stop`
sends. Details: `packages/cursor/README.md`.

Each harness is its own pairing with its own grant: Claude Code keeps `~/.wybe-connect/`, Codex
and Cursor use `~/.wybe-connect/codex/` and `~/.wybe-connect/cursor/`.

## Claude Desktop, claude.ai and ChatGPT (no hooks)

These assistants call the node from their vendor's cloud, through a custom connector at
`https://dittfirma.wybe.me/mcp` (your company's own address). Nothing is installed from this
repository; what they need is a standing instruction and a sync prompt. The texts below are
generated from `texts/standing.json`, the file the node's connect cards pin against.

<!-- texts:begin (generated from texts/standing.json by `npm run sync-texts`; edit the JSON, not this block) -->

### Fast instruks / Standing instruction

**Norsk**

> Jeg har koblet til KI-kollegaen min i Wybe (verktøyet «wybe»). Når vi har snakket om jobben min og du har lært noe varig – prosjekter, beslutninger, arbeidsmåte, verktøy, ideer – så tilby å sende det dit med «remember», og vis meg hva du sender før du sender. Kun jobb: aldri noe privat, aldri noe om andre personer, aldri passord, nøkler eller andre hemmeligheter. Koblingen går bare én vei: du kan sende til KI-kollegaen, men aldri lese noe tilbake derfra. Hvis svaret fra verktøyet har åpne spørsmål, still meg ett av dem når det passer, og send svaret mitt med «answers». Jeg bestemmer hva som deles.

**English**

> I have connected my Wybe AI colleague (the «wybe» tool). When we have talked about my work and you have learned something durable – projects, decisions, how I work, tools, ideas – offer to send it there with «remember», and show me what you will send before you send it. Work only: never anything private, never anything about other people, never passwords, keys or other secrets. The connection is one way: you can send to my AI colleague but never read anything back from it. If the tool's answer carries open questions, ask me one of them when it fits and send my answer with «answers». I decide what is shared.

### Synk-melding / Sync prompt

**Norsk**

> Synk med KI-kollegaen min i Wybe: gå gjennom det vi har snakket om (kun jobb) og lag en kort liste over varige fakta – prosjekter, beslutninger, arbeidsmåte, verktøy, ideer, research og gjentakende oppgaver. Ta ikke med noe privat, noe om andre personer eller hemmeligheter som passord og nøkler. Vis meg listen først; når jeg har godkjent den, send den med «remember» (ett punkt per faktum). Hvis svaret har åpne spørsmål, still meg det første.

**English**

> Sync with my Wybe AI colleague: go through what we have talked about (work only) and make a short list of durable facts – projects, decisions, how I work, tools, ideas, research and recurring tasks. Leave out anything private, anything about other people, and secrets such as passwords and keys. Show me the list first; once I have approved it, send it with «remember» (one item per fact). If the answer carries open questions, ask me the first one.

### Claude Desktop / claude.ai

**Norsk**

1. Åpne Claude (skrivebordsappen eller claude.ai) og gå til Customize → Connectors → + → Add custom connector.
2. Kall den «wybe» og lim inn adressen til KI-kollegaen din, for eksempel https://dittfirma.wybe.me/mcp (bruk firmaets egen adresse).
3. Trykk Connect, logg inn med passnøkkelen din på auth.wybe.me og kryss av for det du vil dele. Du kan oppheve koblingen når som helst under «Mine koblinger».
4. Lim inn den faste instruksen i Claude sine personlige preferanser eller i instruksjonene til et prosjekt. Bruk synk-meldingen når du vil sende et sammendrag.

**English**

1. Open Claude (the desktop app or claude.ai) and go to Customize → Connectors → + → Add custom connector.
2. Name it «wybe» and paste your AI colleague's address, for example https://dittfirma.wybe.me/mcp (use your company's own address).
3. Click Connect, sign in with your passkey at auth.wybe.me and tick what you want to share. You can revoke the connection at any time under «Mine koblinger».
4. Paste the standing instruction into Claude's personal preferences or into a project's instructions. Use the sync prompt when you want to send a summary.

### ChatGPT

**Norsk**

1. Slå på utviklermodus i ChatGPT på nett: Settings → Security and login → Developer mode (Plus, Pro, Business, Enterprise og Edu). Utviklermodus lar ChatGPT bruke verktøy som skriver; KI-kollegaen tar bare imot og gir ingenting tilbake.
2. Gå til ChatGPT Plugins, trykk + og lag en utviklermodus-app med adressen til KI-kollegaen din, for eksempel https://dittfirma.wybe.me/mcp (bruk firmaets egen adresse), og OAuth.
3. Logg inn med passnøkkelen din på auth.wybe.me og kryss av for det du vil dele. Du kan oppheve koblingen når som helst under «Mine koblinger».
4. Lim inn den faste instruksen under Customize ChatGPT (egendefinerte instruksjoner). Bruk synk-meldingen når du vil sende et sammendrag.

**English**

1. Turn on developer mode in ChatGPT on the web: Settings → Security and login → Developer mode (Plus, Pro, Business, Enterprise and Edu). Developer mode lets ChatGPT use tools that write; your AI colleague only receives and gives nothing back.
2. Go to ChatGPT Plugins, press + and create a developer-mode app with your AI colleague's address, for example https://dittfirma.wybe.me/mcp (use your company's own address), and OAuth.
3. Sign in with your passkey at auth.wybe.me and tick what you want to share. You can revoke the connection at any time under «Mine koblinger».
4. Paste the standing instruction under Customize ChatGPT (custom instructions). Use the sync prompt when you want to send a summary.

<!-- texts:end -->

## How it works

```
Claude Code ──hook stdin (transcript_path)──▶ hooks/flush.js
                                                │ delta since the cursor (~/.wybe-connect/state/<id>.json)
                                                │ scope-aware payload (lib/transcript.js)
                                                │ redaction (lib/redact.js)
                                                ▼
                                    lib/post.js ── JSON-RPC tools/call report_session ──▶ https://<slug>.wybe.me/mcp
                                                │ Bearer wat_… from ~/.wybe-connect/credentials.json
                                                │ 401 → one refresh → else queue
                                                │ unreachable → ~/.wybe-connect/queue/ (7 days / 50 MB, oldest dropped)
                                                ▼
                                    next flush drains the queue, oldest first
```

**How a hook reaches the node.** A Claude Code hook is a plain process: it has no MCP client
and no access to Claude Code's own OAuth session. So the plugin obtains its **own** grant once
(`bin/connect.js` runs the OAuth 2.1 authorization-code flow with PKCE against `auth.wybe.me`:
discovery, dynamic client registration with a loopback `redirect_uri`, browser, code exchange)
and stores it in `~/.wybe-connect/credentials.json` (owner-only). The hooks then speak MCP's
Streamable HTTP transport directly (`initialize`, `notifications/initialized`, `tools/call`)
with `fetch`. The interactive tools (`remember`, `import_conversation`, `pending_questions`)
go through Claude Code's own MCP client, added with `claude mcp add --transport http wybe
<url>`, which drives its own consent. Two grants, one person, same scopes screen. The plugin
ships no `.mcp.json` because the node URL is per person and a marketplace install cannot inject
it.

**Open questions.** A hook cannot call `pending_questions`. Every tool response carries
`open_questions[]`; `flush.js` caches the last set and `session-start.js` hands it to Claude
at the next session start, together with the standing instruction.

**Failure posture.** Every hook exits 0 whatever happens, writes at most one line to stderr,
and never prints a token or a payload. An unreachable node queues the delta locally; the next
flush drains the queue. A queue older than 7 days or larger than 50 MB loses its oldest items.

## Layout

```
lib/            shared, dependency-free: redact, transcript, codex-rollout, cursor-spool, post, oauth,
                queue, home, flush, session-context, hook-io, connect-cli
packages/
  claude-code/  the Claude Code plugin (plugin.json, hooks/, bin/connect.js, skills/connect)
  codex/        the Codex plugin (.codex-plugin/, hooks/, bin/connect.js, skills/connect, AGENTS.md
                and config.toml snippets)
  cursor/       the Cursor plugin (.cursor-plugin/, hooks/, bin/connect.js, skills/connect, mcp.json snippet)
                every package ships a byte-identical copy of lib/
texts/standing.json               the Claude Desktop / ChatGPT texts (nb + en)
test/           node --test; fixtures are synthetic (scripts/codex-fixtures.js writes the Codex ones)
.claude-plugin/marketplace.json   Claude Code's listing
.agents/plugins/marketplace.json  Codex's listing
.cursor-plugin/marketplace.json   Cursor's listing
```

## Development

```
node --test                  # every suite
node test/redact-weaken.js   # the mutation harness (run directly, not under node --test)
npm run sync-lib             # refresh packages/*/lib after editing lib/
npm run sync-texts           # regenerate the README's texts section after editing texts/standing.json
npm ls                       # must print nothing under the package: zero dependencies
```

Node 20.11 or newer. No dependencies, ever: the code runs inside people's editors.

## Not yet

- **Live proof against `auth.wybe.me` and a real node** (plan track D3). The OAuth client and the
  poster are tested against fakes and a real loopback server; the authorization server (Atlas
  track A3–A5) and the node's `/mcp` (wybe-node track B2) are being built in parallel. Field
  names on the token response (`scope`) and the tool answer (`structuredContent.open_questions`)
  are the plan's, to be confirmed on first contact.
- **Refresh before expiry.** The hooks refresh only on a 401; `expiresAt` is stored but not
  consulted. Harmless (one extra round trip per hour at most), noted for completeness.
- **`private_key_jwt` client auth and CIMD** (plan A5.1/D7): this client is a public DCR
  client (`token_endpoint_auth_method: none`); the other mechanisms are for the vendor clouds.
- **A live run in Codex and in Cursor.** Both adapters are tested by spawning their hook scripts
  with stdin shaped from the vendors' published schemas and docs, against synthetic fixtures. The
  Codex rollout reader was also checked against the structure of real Codex desktop-app rollouts;
  the Codex CLI's legacy history mode and Cursor itself have not been run. See the packages'
  READMEs for the exact list.
- **A dry run in a fresh `~/.claude` sandbox** with the marketplace installed from a local path
  (C2.3's check): the hook scripts are tested by spawning them with hook-shaped stdin; the
  marketplace install itself has not been exercised end to end.

## Kort på norsk

`wybe-connect` er den åpne (MIT) klientsiden som lar kodeassistenten din (Claude Code, Codex,
Cursor) mate KI-kollegaen din i Wybe. Den **sender bare** — ingenting leses tilbake. Alt **sladdes på din
maskin først** (nøkler, passord i tilkoblingsstrenger, private nøkler, fødselsnummer,
e-postadresser). Hvor mye som deles velger du én gang, på samtykkeskjermen på `auth.wybe.me`:

- **Fakta og prosjekter** (`remember`): varige fakta om jobben din som Claude velger å lagre.
- **Samtalesammendrag** (`conversations`): kun når du ber om det.
- **Arbeidsøkter — hva du ba om** (`sessions:light`): prosjektnavn, gren, filer som ble endret,
  varighet og **dine egne meldinger**. Ingen tekst fra assistenten.
- **Arbeidsøkter — alt innhold** (`sessions:full`): i tillegg assistentens svar og
  verktøytrafikk, sladdet.

Kun jobb. Å oppheve koblingen stopper strømmen; å slette det som ble lært er en egen handling.
Lim inn i Claude Code, Codex eller Cursor: *«Koble meg til KI-kollegaen min i Wybe:
https://dittfirma.wybe.me»*. For Claude Desktop og ChatGPT: se den faste instruksen og
synk-meldingen over.

## Licence

MIT, Wybe Labs AS 2026. See `LICENSE`.
