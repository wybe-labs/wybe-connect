# wybe-connect

The public, MIT-licensed, dependency-free client side of **Andre KI-assistenter**: it lets a
person's coding harness (Claude Code, Codex, Cursor) feed their Wybe AI colleague (their Wybe
node), and carries the standing texts for assistants without hooks (Claude Desktop / claude.ai,
ChatGPT). Three promises, in order of importance:

1. **Only sends.** There is no tool, scope or code path by which the harness reads anything
   from the node. The node retrieves and acts on its own. The one thing that comes back is a
   task the person gave their colleague for an open session (see "Tasks from the colleague").
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
| `remember` | Fakta og prosjekter | durable facts about your **work** that Claude decides to store: projects, decisions, preferences, tools. Claude is told "work only" every session. | when Claude calls the `remember` tool, typically at the end of a session; and (Claude Code, Codex) from the background distil: at most every 6 hours, and when you press «Importer» |
| `conversations` | Samtalesammendrag | a title and a summary of a past chat, and its messages only if you ask for them | only when you explicitly ask Claude to import a conversation |
| `sessions:light` | Arbeidsøkter — hva du ba om | per session: project name (the folder name), the **names** of your git remotes (never their URLs), branch, files Claude wrote or edited, start/end time, and **your own prompts**. Zero assistant text, zero tool output, zero thinking. Prompts written by Claude to its own subagents are excluded; text a hook injected into your prompt is stripped. | automatically at every stop, before every context compaction, and at session end |
| `sessions:full` | Arbeidsøkter — alt innhold | everything in `sessions:light` plus Claude's replies and every tool call's input and output (each clipped to 4000 characters). Thinking blocks still never leave. | same as above |

Claude Code and Codex send no `sessions:*` payload: their hooks only note the session, and a
background distil on your machine turns your sessions into short `remember` facts (see "The
background distil"). The `sessions:*` rows apply to Cursor.

With no `sessions:*` scope the hooks build nothing and send nothing. Every payload carries a
`redaction.families` count (which families hit, how often, never the values) so a review can
see the redactor working.

Everything is redacted before it is written anywhere, including the local queue.

### The redaction families

Redaction reads structure first, then known token prefixes, then keys, then entropy:

| Family | What it catches |
|---|---|
| `pem-private-key` | `-----BEGIN ... PRIVATE KEY-----` blocks, whole |
| `secret-block` | a YAML `\|` or `>` block under a secret key (nested YAML, templates, public keys and prose stay) |
| `url-userinfo` | `scheme://user:password@host` in any URL or DSN (the scheme and host stay) |
| `auth-header` | the credential in `Authorization:` (Bearer, Token, Basic, a Digest `response=`), and a bare `Bearer <token>` |
| `cookie` | `Cookie:` and `Set-Cookie:` values |
| `cli-secret` | `--password x`, `--token=x`, `mysql -p<pw>`, `docker login -p x`, `curl -u user:pw` |
| `wybe-credential`, `openai-key`, `aws-access-key`, `github-token`, `gitlab-token`, `npm-token`, `slack-token`, `slack-webhook`, `stripe-key`, `google-api-key`, `sendgrid-key`, `twilio-key`, `discord-token`, `microsoft-token`, `jwt` | known vendor token prefixes and shapes, wherever they stand |
| `keyed-secret` | the value under a secret key (`password`, `passord`, `secret`, `token`, `api_key`, `<x>_key`, ...) in JSON at any escape depth, YAML, env and shell lines, headers, URL queries and connection strings; placeholders, types, code, paths, labels and sentences stay, and so do ids under keys like `page_token` or `cache_key` |
| `high-entropy` | a 40+ character random string that no key vouched for |
| `fodselsnummer` | Norwegian national identity numbers whose two mod-11 control digits verify (an ordinary 11-digit number is left alone) |
| `email` | e-mail addresses; `{ emails: false }` keeps them |

`test/redact-table.test.js` is the frozen table: every leak and every false positive with its
exact expected output, and a second pass that must change nothing. It also switches off each
family in turn and demands that some row goes red, so a family that stopped protecting cannot
pass unnoticed.

### What never leaves, under any scope

Thinking blocks. Subagent threads. The contents of files Claude only read (light). Your git
remote URLs. Anything from other projects than the one the session ran in. The OAuth token
itself (it is sent as a header to your node, and to nothing else).

## Getting started (Claude Code)

One command in a terminal (Claude Code 2.1.292 or newer):

```
claude plugin install wybe-connect --marketplace wybe-labs/wybe-connect
```

(or, inside Claude Code: `/plugin install wybe-connect --marketplace wybe-labs/wybe-connect`).
Then paste one of these with your own node address:

> Koble meg til KI-kollegaen min i Wybe: https://dittfirma.wybe.me

> Connect me to my Wybe AI colleague at https://dittfirma.wybe.me

Claude runs the `connect` skill, which calls the plugin's own `wybe` MCP server: a browser
opens on `auth.wybe.me`, you log in with your passkey and tick the scopes. That one sign-in
serves both the hooks and the `remember` tool; nothing to copy, no `claude mcp add`. The first
sync then runs by itself: the node asks for an import when the connection is made, and the
plugin distils your recent sessions and memory in the background. There is no step for you.
From then on the hooks do the rest.

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
the plugin's `connect` skill runs the OAuth flow as its own client and offers the standing line
for `~/.codex/AGENTS.md`. That one grant serves the hooks and the plugin's own MCP server
(`packages/codex/mcp.json`), so there is no MCP server to add and no second sign-in. Like Claude
Code, Codex then sends the essence only: a background distil (`codex exec`) turns your sessions
into short `remember` facts, and on first connect it imports your Codex sessions of the last 30
days by itself. Codex runs a plugin's hooks only after you have trusted them once. Details and
what was verified where: `packages/codex/README.md`.

## Getting started (Cursor)

Install the plugin listed in `.cursor-plugin/marketplace.json` from Cursor's plugin view (or copy
`packages/cursor/hooks.user.example.json` into `~/.cursor/hooks.json`), then paste the same
sentence. Cursor's transcript format is not documented, so the Cursor hooks build the session
from the documented hook payloads instead: each hook spools one redacted record, and `stop`
sends. Details: `packages/cursor/README.md`.

Each harness is its own pairing with its own grant: Claude Code keeps `~/.wybe-connect/`, Codex
and Cursor use `~/.wybe-connect/codex/` and `~/.wybe-connect/cursor/`.

**Several nodes or accounts.** Within a harness, each connect is its own connection
(`connections/<name>/`: grant, queue, question cache), keyed by the node host or by `--name`, so
a second node never replaces the first and one node's queue is never sent to another. A session
uses the connection its first hook found: one it was moved to (`connect.js use <name> --session
<id>`), else `WYBE_CONNECT_NODE=<name>` in the harness's environment, else the default (the one
connected or `use`d last, or the only one). `connect.js list` and `connect.js remove <name>`
manage them. A 0.1 `credentials.json` moves under its node on the first hook, queue included.
A session is the harness's `session_id`: `/clear` starts a new one (where any new session goes),
`/resume` keeps it. A move sends the session's later transcript lines to the new connection; the
lines written before it stay with the one it left, and a removed connection's lines go nowhere.
In Claude Code the background distil is kept per connection too. The plugin's `wybe` MCP server
remembers no session: with one connection, and every session on it, its tools go there. With two
or more, or a session sent elsewhere (a removed connection pins its sessions to none until
`connect.js use`), every call passes the `session_id` the SessionStart note gives, and a call
without it is refused. Its `connect` tool stores a new connection and makes it the default.

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

## Tasks from the colleague

The person can ask their Wybe AI colleague to hand a task to one of their open Claude Code or
Codex sessions, and to read the result. This is the only thing that ever comes from the node:
the person's own words for a task, never anything the colleague knows.

- **Which sessions are open.** Each session's hooks send `sessions_report`: the session id,
  harness, project (the last segment of the working directory, never the path), a title (the
  first prompt, redacted, at most 80 characters), the vendor account as the harness knows it
  locally (Claude Code's signed-in e-mail from `.claude.json`; Codex's from the `email` claim of
  `auth.json`'s id token, decoded on the machine; no token is ever read out or sent), when it
  started, when it was last active, and open or closed. At start, every 5 minutes while open,
  and at the end.
- **Delivery into the live session.** A poller per session asks the node's `inbox` for that
  session's tasks about every 20 s (backing off while the node is down).
  - Claude Code: `hooks/task-wait.js` is an `asyncRewake` hook on SessionStart, Stop and
    StopFailure. It waits in the background and exits 2 with the notice when a task arrives,
    which wakes Claude even when the session is idle. Every Stop re-arms it, a newer one
    supersedes the older, and it pauses while the person's own turn runs (UserPromptSubmit), so
    a task always gets a turn of its own.
  - Codex: no hook can wake an idle Codex session, so SessionStart starts a detached poller
    that runs `codex queue --thread <session> --message <notice>`. If that fails, the next
    Stop hook hands the notice over as a `decision: block` (a new turn), once.
- **The person's yes, by the node's access level.** At `read` nothing is ever delivered. A task
  in mode `run` (the person already said yes to their colleague) carries its text in the
  notice. A task in mode `confirm` carries only its id: the session must call the plugin's
  `take_task` tool, which shows the exact text in an MCP elicitation form (Godta / Avvis) and
  returns it only on accept; a decline sends `task_result` refused.
- **The result.** The Stop that ends the task's turn sends `task_result` with status `done`
  (Claude Code's StopFailure: `failed`) and the turn's last message, redacted, at most 20 000
  characters. Once per task.

Limits: a client without elicitation gets the confirm task's text with the instruction to show
it word for word and act only after an explicit yes in the chat; that yes is the model's
reading of the chat, not a form. A Claude Code session idle for more than 24 hours stops
waiting until its next Stop. A Codex task's result is taken from the turn whose prompt carries
the task's mark (`[wybe-task <id>]`), which relies on `codex queue` putting the notice in the
rollout as that turn's prompt.

## How it works

### The background distil (Claude Code)

```
Stop / SessionEnd / PreCompact ─▶ hooks/flush.js ─ one note file per transcript (lock-free)
                                        │ the scheduler (lib/distil.js maybeRun, under the distil lock)
                                        ▼
            bin/distil-run.js (detached watchdog, ends the run at 30 min)
                │ claude -p  --tools Read,Glob,Grep  --strict-mcp-config (only the plugin's `wybe`)
                │   --setting-sources ""  (none of your hooks, plugins or settings; your login)
                │   reads the noted transcript ranges, calls remember … then distil_done
                │   └▶ bin/mcp-proxy.js in distil mode: redacts, appends to the run's OUTBOX
                ▼
            delivery: each outbox record ─ remember + idempotency_key ─▶ the node
                      each ack (ok and a numeric `stored`) ─▶ the run's ACKS file
```

The run reads only what its plan names: each noted transcript, and for an import also
`~/.claude/CLAUDE.md` and, of the projects in those transcripts, their `CLAUDE.md` and auto
memory folder. Each is one path-scoped `Read(//…)` rule in the run's own settings file
(`runs/<run>.settings.json`, passed with `--settings` and removed when the run ends; on Windows in
Claude Code's POSIX form, `//c/Users/…`); everything else is refused. It runs in the distil's
own folder, with none of your settings files, so your hooks and plugins do not run in it.

It runs on your machine and on your own Claude subscription. Nothing raw leaves the machine:
only the facts the run chose, redacted again by `lib/redact.js`. What makes it exactly once:

- **Produce, then deliver.** The run never talks to the node. Until it calls `distil_done`,
  nothing is sent, so a run that dies is simply redone. Once it has, its outbox is frozen: a
  retry sends only the records without an ack, with the same `idempotency_key`, and claude never
  runs again for them.
- **Success is the node's acknowledgement.** A record counts only when the node answered
  `ok: true` with a numeric `stored`. An import counts only with `import_done: true`. An empty
  outbox, a run without `distil_done`, or claude's exit code is never a success.
- **Each line is distilled at most once per node.** The "distilled up to" mark is kept per
  node and per transcript file, and lasts as long as the file does. Every run reads a transcript
  from its mark on, whatever started it: a hook, the import, or a session resumed months later.
  The import does not let the model look for transcripts: the plugin lists every session of
  the last 30 days that is not distilled yet (the distil runs' own left out), and the model
  reads only those ranges.
- **One distil per connection.** Each connection keeps its own notes, state, outboxes and locks
  under `connections/<name>/`. A session's Stop hook notes it for the connection that session
  uses, and a run reads only those sessions and delivers only to that connection's node, with
  its grant. Every Stop hook ticks every connection, so an outbox never waits for a session of
  its own. An import takes only sessions fixed to its connection, or never fixed to any. A
  delivery whose grant is removed or replaced meanwhile stops and writes nothing back; the next
  tick sends the rest with the grant on disk then.
- **An outbox belongs to one node.** Its keys are made with the node's address in them, and it
  is sent only to that node. After connecting to another colleague it waits on this machine,
  and is sent if this Claude Code connects to that node again.
- **Checksummed, append-only files** (`lib/ledger.js`). Each line carries its own checksum. A
  torn or altered line never counts: a torn outbox before `distil_done` redoes the run, and a
  torn ack re-sends that record. A line damaged after `distil_done` is set aside to
  `<run>.torn`, and the intact records are still delivered.
- **A refusal is set aside.** A record the node refuses with a tool error is recorded as
  refused and never sent again, so it never holds up the records and sessions behind it.
- **A real lock** (`lib/lock.js`). A live holder is never taken over, however slow. Only a dead
  holder's lock is, and a holder checks its token before it writes. The hooks need no lock.
- **Bounded, never silent.** Pending plus the run in flight hold at most 2000 transcripts.
  Beyond that, notes wait on disk. A failed run's transcripts go back in their place. Past
  20 000 waiting notes, a note is dropped with a count, and the next session start says so.
- A failure retries after 30 minutes. SessionStart tells Claude once per kind of problem, and
  once for each record set aside (refused, damaged, or kept for another colleague).

The node should keep each `idempotency_key` once. Until it does, a reply lost after the node
stored the facts (beyond the 60 s delivery timeout) means that one record can be stored twice.

### The background distil (Codex)

The same pipeline, the same files and the same guarantees, with Codex's pieces:

- **The hooks** (Stop, PreCompact; SessionEnd only notes, as Codex caps it at 3 s) note the
  rollout Codex names in `transcript_path`. A spawned subagent's thread (`agent_id`, or a
  subagent or internal `source` in `session_meta`) and a compressed rollout are not noted. No
  rollout delta is sent.
- **The run** is a headless `codex exec`, started by `bin/distil-run.js` in the distil's own
  folder:
  `codex exec --sandbox read-only --json --ephemeral --skip-git-repo-check -c features.hooks=false -c mcp_servers={}`
  `-c mcp_servers.wybe_distil.command="<node>" -c mcp_servers.wybe_distil.args=["<plugin>/bin/mcp-proxy.js"]`
  `-c mcp_servers.wybe_distil.env={ WYBE_CONNECT_DISTIL = "<run>", ... } "<prompt>"`.
  `features.hooks=false` keeps your own hooks (user, project and plugin) out of the run.
  `mcp_servers={}` drops every MCP server you configured, so the plugin's own server in distil
  mode (named `wybe_distil`, so it is never confused with the interactive `wybe`) is the only
  one. Codex starts a stdio server with only a few variables of its own
  environment, so the distil mode travels in the server's `env` table. `--ephemeral` keeps the
  run from writing a rollout, so it never becomes a session to import (a rollout whose first
  prompt is the distil prompt is left out as well).
- **The import** lists `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl` changed in
  the last 30 days, the person's threads only, and also reads `~/.codex/AGENTS.md` and the
  projects' `AGENTS.md`.
- **First connect.** The node asks for the first sync by itself (an `import_request` in its
  answers). The plugin's MCP server (`mcp.json` → `bin/mcp-proxy.js`) asks the node for it
  2 seconds after Codex starts it, every 5 minutes, and at once when a sign-in through its
  `connect` tool finishes. The import then runs in the background: no button and no command.

It runs on your machine and on your own ChatGPT/Codex plan.

### Cursor

```
Cursor ──hook stdin (transcript)──▶ hooks/flush.js
                                                │ delta since the cursor (~/.wybe-connect/state/<id>.json)
                                                │ scope-aware payload (lib/transcript.js)
                                                │ redaction (lib/redact.js)
                                                ▼
                                    lib/post.js ── JSON-RPC tools/call report_session ──▶ https://<slug>.wybe.me/mcp
                                                │ Bearer wat_… from ~/.wybe-connect/connections/<node>/credentials.json
                                                │ 401 → one refresh → else queue
                                                │ unreachable → ~/.wybe-connect/connections/<node>/queue/ (7 days / 50 MB, oldest dropped)
                                                ▼
                                    next flush drains the queue, oldest first
```

**How a hook reaches the node.** A Claude Code hook is a plain process: it has no MCP client
and no access to Claude Code's own OAuth session. So the plugin obtains its **own** grant once
(`bin/connect.js` runs the OAuth 2.1 authorization-code flow with PKCE against `auth.wybe.me`:
discovery, dynamic client registration with a loopback `redirect_uri`, browser, code exchange)
and stores it in `~/.wybe-connect/connections/<node>/credentials.json` (owner-only). The hooks then speak MCP's
Streamable HTTP transport directly (`initialize`, `notifications/initialized`, `tools/call`)
with `fetch`. The interactive tools (`remember`, `import_conversation`, `pending_questions`)
go through the plugin's own MCP server (`.mcp.json` → `bin/mcp-proxy.js`, a stdio server):
before you connect it offers only `connect(node_url)`, which runs the same OAuth flow and stores
the same `credentials.json`; after that it lists the node's own tools and forwards each call to
the node's `/mcp` with that grant (one refresh on 401). One grant, one sign-in; the node URL is
never in `.mcp.json`, so a marketplace install works for everyone. (`bin/connect.js` still runs
the flow from a terminal.)

**Open questions.** A hook cannot call `pending_questions`. Every tool response carries
`open_questions[]`; `flush.js` caches the last set and `session-start.js` hands it to Claude
at the next session start, together with the standing instruction.

**Failure posture.** Every hook exits 0 whatever happens, writes at most one line to stderr,
and never prints a token or a payload. An unreachable node queues the delta locally; the next
flush drains the queue. A queue older than 7 days or larger than 50 MB loses its oldest items.

## Layout

```
lib/            shared, dependency-free: redact, transcript, codex-rollout, cursor-spool, post, oauth,
                queue, home, flush, session-context, hook-io, connect-cli, mcp-proxy,
                distil (the background distil), ledger (checksummed records), lock,
                session-info, bridge and task-poller (tasks from the colleague)
packages/
  claude-code/  the Claude Code plugin (plugin.json, hooks/, bin/connect.js, skills/connect)
  codex/        the Codex plugin (.codex-plugin/, mcp.json, hooks/, bin/{connect,mcp-proxy,distil-run}.js,
                skills/connect, AGENTS.md and config.toml snippets)
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
node --test                  # every suite, the redaction table and its mutation check included
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
  the Codex CLI's legacy history mode and Cursor itself have not been run. The Codex distil is
  tested with a fake `codex` that plays an obedient `codex exec`; a real `codex exec` run has not
  been made. See the packages' READMEs for the exact list.
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
