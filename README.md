# wybe-connect

The public, MIT-licensed, dependency-free client side of **Andre KI-assistenter**: it lets a
person's coding harness (Claude Code first; Codex and Cursor planned) feed their Wybe colleague
(their Wybe node). Three promises, in order of importance:

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

> Koble meg til Wybe-kollegaen min: https://<slug>.wybe.me

> Connect me to my Wybe colleague at https://<slug>.wybe.me

Claude runs the `connect` skill: a browser opens on `auth.wybe.me`, you log in with your
passkey and tick the scopes, and Claude runs the first sync (the opening kit: projects, how you
work, tools, ideas, research, recurring tasks; work only). From then on the hooks do the rest.

Revoking the pairing (under "Mine koblinger" on your node) stops the flow. Erasing what the
node learned from this assistant is a separate, explicit action there. Both are stated on the
consent screen.

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
lib/            shared, dependency-free: redact, transcript, post, oauth, queue, home, flush, session-context
packages/
  claude-code/  the plugin (plugin.json, hooks/, bin/connect.js, skills/connect, and a byte-identical copy of lib/)
  codex/        placeholder (track C3)
  cursor/       placeholder (track C4)
test/           node --test; fixtures are synthetic
.claude-plugin/marketplace.json   the marketplace listing one plugin
```

## Development

```
node --test                  # every suite
node test/redact-weaken.js   # the mutation harness (run directly, not under node --test)
npm run sync-lib             # refresh packages/claude-code/lib after editing lib/
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
- **Codex CLI (C3) and Cursor (C4)**: README placeholders only.
- **Standing-instruction texts for Claude Desktop / ChatGPT (C5)**: not in this repository yet.
- **A dry run in a fresh `~/.claude` sandbox** with the marketplace installed from a local path
  (C2.3's check): the hook scripts are tested by spawning them with hook-shaped stdin; the
  marketplace install itself has not been exercised end to end.

## Kort på norsk

`wybe-connect` er den åpne (MIT) klientsiden som lar kodeassistenten din (Claude Code først)
mate Wybe-kollegaen din. Den **sender bare** — ingenting leses tilbake. Alt **sladdes på din
maskin først** (nøkler, passord i tilkoblingsstrenger, private nøkler, fødselsnummer,
e-postadresser). Hvor mye som deles velger du én gang, på samtykkeskjermen på `auth.wybe.me`:

- **Fakta og prosjekter** (`remember`): varige fakta om jobben din som Claude velger å lagre.
- **Samtalesammendrag** (`conversations`): kun når du ber om det.
- **Arbeidsøkter — hva du ba om** (`sessions:light`): prosjektnavn, gren, filer som ble endret,
  varighet og **dine egne meldinger**. Ingen tekst fra assistenten.
- **Arbeidsøkter — alt innhold** (`sessions:full`): i tillegg assistentens svar og
  verktøytrafikk, sladdet.

Kun jobb. Å oppheve koblingen stopper strømmen; å slette det som ble lært er en egen handling.
Lim inn i Claude Code: *«Koble meg til Wybe-kollegaen min: https://<slug>.wybe.me»*.

## Licence

MIT, Wybe Labs AS 2026. See `LICENSE`.
