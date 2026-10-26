// The connect skills. The node starts the first sync by itself when the connection is made (an
// `import_request` in its answers), so a skill must not run a second one: an interview at connect
// stored every fact twice. This guard checks what a connect skill does, not its wording:
//   - its steps are exactly the pairing steps (a new step, whatever it is called, is red);
//   - no step has the agent ask the person anything but the address;
//   - no step has the agent send, store or sync anything, or call a tool other than `connect`;
//   - the confirmation says the first sync is the node's import and starts by itself.
// The mutants below re-add a first sync in several wordings; each must turn the guard red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PACKAGES = ['claude-code', 'codex', 'cursor'];

const STEPS = {
  'claude-code': ['Take the node URL from the sentence.', 'Make sure the plugin is installed.', 'Sign in once:', 'Confirm'],
  codex: ['Take the address from the sentence.', 'Run the OAuth flow', 'Add the MCP server for the interactive tools', 'Offer the standing line for `~/.codex/AGENTS.md`', 'Confirm'],
  cursor: ['Take the address from the sentence.', 'Run the OAuth flow', 'Add the MCP server for the interactive tools', 'Confirm'],
};

const skillOf = (pkg) => readFileSync(join(ROOT, 'packages', pkg, 'skills', 'connect', 'SKILL.md'), 'utf8');

const NEGATED = /\b(do not|don't|never|not yours|is not a step|no step|ikke)\b/i;
const ABOUT_ADDRESS = /\b(address|url|adresse)\b/i;
// The agent asking the person: an imperative "ask", or "ask the person/them".
const ASKS_PERSON = /(^|[.:;]\s*|\b(then|and|now|also|afterwards)\s+)(ask|interview|spør|find out)\b|\b(ask|interview|question)s? (the person|them|him|her)\b/i;
// The agent sending or storing: an imperative verb, or "you <verb>".
const AGENT_SENDS = /(^|[.:;]\s*|\b(then|and|now|also|afterwards)\s+)(send|store|save|submit|sync|upload|push|record|pass)\b|\byou (send|store|save|submit|sync|upload|push|record)\b/i;
// A tool call the agent makes.
const CALLS = /\bcall\b/i;
// A sentence that only lists the scopes or the tools on offer.
const ENUMERATION = /sessions:light|pending_questions/;

/** The sentences of a block of markdown, list markers and code fences stripped. */
function sentences(block) {
  return block
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z"«(`])|\n(?=\s*\d+\.\s)/)
    .map((s) => s.replace(/\s+/g, ' ').replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);
}

/** Everything wrong with one connect skill's text; [] when it does only what a connect skill must. */
export function problems(pkg, skill) {
  const out = [];
  const from = skill.indexOf('## Steps');
  const to = skill.indexOf('## Never');
  if (from < 0 || to < from) return ['no "## Steps" section before "## Never"'];
  const steps = skill.slice(from + '## Steps'.length, to);
  const titles = [...steps.matchAll(/^\d+\.\s+\*\*(.+?)\*\*/gm)].map((m) => m[1]);
  if (JSON.stringify(titles) !== JSON.stringify(STEPS[pkg])) out.push(`the steps are not the pairing steps: ${JSON.stringify(titles)}`);
  for (const s of sentences(steps)) {
    if (NEGATED.test(s)) continue;
    if (ASKS_PERSON.test(s) && !ABOUT_ADDRESS.test(s)) out.push(`asks the person something other than the address: "${s.slice(0, 120)}"`);
    if (AGENT_SENDS.test(s)) out.push(`has the agent send or store something: "${s.slice(0, 120)}"`);
    if (/\bremember\b/i.test(s) && !ENUMERATION.test(s)) out.push(`uses remember while connecting: "${s.slice(0, 120)}"`);
    if (CALLS.test(s) && !/`connect`/.test(s)) out.push(`calls a tool other than connect: "${s.slice(0, 120)}"`);
  }
  const confirm = steps.slice(steps.search(/^\d+\.\s+\*\*Confirm\*\*/m));
  if (!/import/i.test(confirm) || !/by itself|automatically/i.test(confirm)) out.push('the confirmation does not say the first sync is the node\'s import, started by itself');
  return out;
}

for (const pkg of PACKAGES) {
  test(`${pkg}: the connect skill only pairs; the node's import is the only first sync`, () => {
    assert.deepEqual(problems(pkg, skillOf(pkg)), []);
  });
}

// A first sync put back into the Claude Code skill, in several wordings and places.
const addStep = (body) => (src) => src.replace('4. **Confirm**', `${body}\n\n5. **Confirm**`);
const inStep = (after, body) => (src) => src.replace(after, `${after} ${body}`);
const MUTANTS = {
  'the old opening kit, verbatim': addStep("4. **First sync: the opening kit.** Ask the person for six things about their work, then call the `wybe` server's `remember` tool with one item per fact."),
  'the same interview in other words': addStep('4. **Welcome sync.** Ask the person, in their language, for their current projects, how they like to work, their tools, ideas, research and recurring tasks (work only). Send the answers with `remember`, one item per fact, before you confirm.'),
  'a step with a harmless title': addStep('4. **Get to know them.** Find out what they are working on this week and keep it for the colleague.'),
  'folded into the sign-in step': inStep('there is nothing else to add or copy.', 'Then ask them which projects matter most right now and store each answer with the wybe tools.'),
  'folded into the confirmation': inStep('From then on, the same distil runs at most every 6 hours.', 'Afterwards interview the person about their tools and ideas.'),
  'a send without the word remember': inStep('there is nothing else to add or copy.', 'Now send a short summary of this session to the colleague.'),
  'a call to another tool': inStep('there is nothing else to add or copy.', 'Then call `import_conversation` with this conversation.'),
  'the confirmation no longer says the import runs by itself': (src) => src.replace(/sync now runs by itself in the background: the node asked for an import, and/, 'sync is yours: and'),
};

for (const [label, mutate] of Object.entries(MUTANTS)) {
  test(`the guard turns red on a first sync put back: ${label}`, () => {
    const src = skillOf('claude-code');
    const mutated = mutate(src);
    assert.notEqual(mutated, src, 'the mutant applies to the current skill');
    assert.ok(problems('claude-code', mutated).length > 0, 'the guard stayed green');
  });
}
