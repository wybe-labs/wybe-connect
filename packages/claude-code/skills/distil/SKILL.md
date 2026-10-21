---
name: distil
description: Distil this person's local Claude Code sessions and memory into a short list of durable WORK facts and send it to their Wybe AI colleague with the `wybe` server's `remember` tool, answering the colleague's open questions on the way. Runs headless in the background (started by wybe-connect when the person presses «Importer» in their Wybe portal, or on the ongoing schedule); use it when the prompt says "Use the wybe-connect `distil` skill", or when the person asks to import or sync their Claude Code history to Wybe.
---

# Distil to Wybe

You are running on the person's own machine, usually without them watching. Your job: read their
local material and send **only the essence**: a short list of durable facts about their work, plus
answers to the questions their Wybe colleague has. Never send transcripts, file contents or logs.

## Modes (from the prompt)

- **import**: the person pressed «Importer». Read every source below. Pass `import_of` (the
  timestamp in the prompt, exactly) in your **last** `remember` call, so the colleague knows the
  import finished.
- **ongoing**: read only the transcripts the prompt lists. No `import_of`.

## Sources (read-only: Read, Glob, Grep; never edit anything)

1. Memory, the richest source, read first (import mode):
   - `~/.claude/CLAUDE.md`
   - `~/.claude/projects/*/memory/MEMORY.md` and the topic files next to it
   - `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` in the project folders the transcripts name
     (the `cwd` field)
2. Transcripts: `~/.claude/projects/*/*.jsonl` (import mode: those from the last 30 days; ongoing
   mode: the listed ones). They are large: do not read them whole. Grep for the person's own
   prompts (`"type":"user"`) and read around the hits that look like decisions, plans or
   preferences. Skip tool output.

## First: the colleague's questions

Call `pending_questions`. For each open question, look for the answer in the material. Answer only
what the material clearly says; leave the rest open.

## What to send

At most **40 items**, each one or two sentences (≤ 400 characters), with a `subject`. Kinds:

- projects and their current state
- decisions and why
- how the person likes to work (arbeidsmåte)
- tools and stack
- recurring tasks
- open threads and ideas
- research they follow

Write in the person's language (Norwegian if their prompts are Norwegian). Merge duplicates.
Prefer what is recent and stated by the person over what an assistant guessed.

**Never send:** anything private, anything about other people beyond their work role, health,
family, money, credentials, keys, tokens, passwords, connection strings, personal ID numbers, file
contents or code. When unsure, leave it out.

Send with `remember`: `items` (the list), `answers` (question ids you answered, with the answer
as an item), and in import mode `import_of`. Split into a few calls if needed; `import_of` goes in
the last one. If there is nothing durable, send nothing (import mode: send one item saying the
import found nothing new, with `import_of`).

Finish with one line: how many items you sent, how many questions you answered. Nothing else.
