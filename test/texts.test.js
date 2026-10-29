import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTexts, readmeBlock } from '../scripts/sync-texts.js';

// C5: texts/standing.json is the source for the Claude Desktop / ChatGPT texts; the README
// section is generated from it and the node's connect cards (plan B4.2) pin against it.

const ROOT = join(import.meta.dirname, '..');
const texts = JSON.parse(readFileSync(join(ROOT, 'texts', 'standing.json'), 'utf8'));
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

const pairs = [texts.standing, texts.sync];
const stepLists = [texts.setup.claude_desktop, texts.setup.chatgpt];
const allNb = [...pairs.map((p) => p.nb), ...stepLists.flatMap((s) => s.nb)];
const allEn = [...pairs.map((p) => p.en), ...stepLists.flatMap((s) => s.en)];

test('the README section is exactly the rendering of texts/standing.json (npm run sync-texts)', () => {
  const block = readmeBlock(readme);
  assert.ok(block, 'README.md carries the texts markers');
  assert.equal(block, renderTexts(texts));
});

test('every text appears verbatim in the README, once per place it is rendered', () => {
  for (const s of [...allNb, ...allEn]) assert.ok(readme.includes(s), `missing from README: ${s.slice(0, 50)}`);
});

test('the whole key set: standing and sync in nb + en, setup steps for Claude Desktop and ChatGPT', () => {
  assert.deepEqual(Object.keys(texts).sort(), ['about', 'mcp_address_example', 'setup', 'standing', 'sync', 'version']);
  assert.equal(texts.version, 1);
  assert.deepEqual(Object.keys(texts.setup).sort(), ['chatgpt', 'claude_desktop']);
  for (const p of pairs) assert.deepEqual(Object.keys(p).sort(), ['en', 'nb']);
  for (const s of stepLists) {
    assert.deepEqual(Object.keys(s).sort(), ['en', 'nb']);
    assert.equal(s.nb.length, s.en.length, 'nb and en have the same steps');
  }
  for (const s of [...allNb, ...allEn]) assert.ok(!s.includes('\n'), 'one paragraph per text (a blockquote / list item each)');
});

test('content rules: work only, send-only, no secrets, the person decides; nb says «KI-kollega» and never «node»', () => {
  for (const [lang, t] of [['nb', texts.standing.nb], ['en', texts.standing.en]]) {
    const rules = lang === 'nb'
      ? [/Kun jobb/, /bare én vei/, /aldri lese noe tilbake/, /passord, nøkler eller andre hemmeligheter/, /Jeg bestemmer hva som deles/]
      : [/Work only/, /one way/, /never read anything back/, /passwords, keys or other secrets/, /I decide what is shared/];
    for (const r of rules) assert.match(t, r, `${lang} standing: ${r}`);
  }
  assert.match(texts.sync.nb, /kun jobb/);
  assert.match(texts.sync.nb, /Vis meg listen først/);
  assert.match(texts.sync.en, /work only/);
  assert.match(texts.sync.en, /Show me the list first/);
  for (const s of allNb) assert.ok(!/\bnoden?\b|\bnode\b/i.test(s), `nb text says node: ${s.slice(0, 60)}`);
  for (const s of allEn) assert.ok(!/\bnode\b/i.test(s), `en text says node: ${s.slice(0, 60)}`);
  assert.ok(allNb.filter((s) => s.includes('KI-kollega')).length >= 4);
  assert.ok(!JSON.stringify(texts).match(/\b(recall|read_memory|ask_colleague)\b/), 'no read-back tool is ever named');
});

test('the ChatGPT card carries the developer-mode step first; both cards use the example address', () => {
  assert.match(texts.setup.chatgpt.nb[0], /utviklermodus/i);
  assert.match(texts.setup.chatgpt.en[0], /developer mode/i);
  assert.equal(texts.mcp_address_example, 'https://dittfirma.wybe.me/mcp');
  for (const s of stepLists) for (const list of [s.nb, s.en]) assert.ok(list.some((x) => x.includes(texts.mcp_address_example)));
});

// The README, package.json and every marketplace and plugin manifest: what a person reads before
// installing. The services are named by their own names, the import has no button, and the one
// exception to "sends only" is said wherever "sends only" is.
const MANIFESTS = [
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
  '.cursor-plugin/marketplace.json',
  'packages/claude-code/.claude-plugin/plugin.json',
  'packages/codex/.codex-plugin/plugin.json',
  'packages/cursor/.cursor-plugin/plugin.json',
];
const PUBLIC_TEXTS = ['README.md', 'package.json', ...MANIFESTS];
// What the plugin itself says: its READMEs, and the connect skills the model reads aloud.
const SKILLS = ['claude-code', 'codex', 'cursor'].map((h) => `packages/${h}/skills/connect/SKILL.md`);
const PLUGIN_TEXTS = [...['claude-code', 'codex', 'cursor'].map((h) => `packages/${h}/README.md`), ...SKILLS];
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const flat = (t) => t.replace(/\s+/g, ' ');
const TASK_EXCEPTION = 'Sends only; the one thing that comes back is a task you gave your colleague for an open session, and one that needs your yes is shown to you first';

test('no «KI-assistenter», «Andre KI» or «Importer» in the README, package.json or any manifest', () => {
  for (const f of PUBLIC_TEXTS) {
    const t = read(f);
    for (const r of [/KI-assistent/i, /Andre KI/i, /«Importer»/]) assert.doesNotMatch(t, r, `${f}: ${r}`);
  }
  for (const f of MANIFESTS) JSON.parse(read(f));
});

test('the README keeps «Only sends» together with its one exception, the task', () => {
  const promise = flat(readme.slice(readme.indexOf('1. **Only sends.**'), readme.indexOf('2. **Redacts')));
  assert.ok(promise.length > 0, 'the README states the «Only sends» promise first');
  assert.match(promise, /The one thing that comes back is a task the person gave their colleague for an open session; one that needs their yes is shown to them first\./);
  assert.match(flat(readme), /sender bare\*\* — det eneste som kommer tilbake er en oppgave du selv har gitt KI-kollegaen til en åpen økt, og en oppgave som trenger ditt ja, vises deg først\./);
});

test('every «see "…"» in the README names a heading the README has', () => {
  const headings = readme.split('\n').filter((l) => /^#{1,4} /.test(l)).map((l) => l.replace(/^#+ /, ''));
  const refs = [...flat(readme).matchAll(/see "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const r of refs) assert.ok(headings.some((h) => h.startsWith(r)), `no heading «${r}»`);
});

test('no manifest says «write-only»: each says it sends only, and what comes back', () => {
  for (const f of MANIFESTS) assert.doesNotMatch(read(f), /write-only/i, f);
  for (const f of ['packages/claude-code/.claude-plugin/plugin.json', 'packages/codex/.codex-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
    assert.ok(read(f).includes(TASK_EXCEPTION), f);
  }
  assert.match(read('package.json'), /the one thing that comes back is a task you gave your colleague for an open session, and one that needs your yes is shown to you first/);
  // A task in mode run carries its text at once (the person said yes to the colleague); only a
  // task that needs the person's yes is shown first. No text may say every task is.
  for (const f of [...PUBLIC_TEXTS, ...PLUGIN_TEXTS]) assert.doesNotMatch(flat(read(f)), /open session, shown to you first/, f);
});

test('the connect skills say the plugin only sends, with the same exception, and never «write-only»', () => {
  for (const f of SKILLS) assert.doesNotMatch(read(f), /write-only/i, f);
  for (const h of ['claude-code', 'codex']) {
    const t = flat(read(`packages/${h}/skills/connect/SKILL.md`));
    assert.match(t, /\*\*only sends\*\*/, h);
    assert.ok(t.includes('the one thing that comes back is a task the person gave their colleague for an open session, and one that needs their yes is shown to them first'), h);
    assert.doesNotMatch(t, /the flow is one way/, h);
  }
  assert.match(flat(read('packages/cursor/skills/connect/SKILL.md')), /\*\*only sends\*\* \(nothing comes back into Cursor\)/);
});

test('no «Importer» button in the plugin READMEs or the connect skills', () => {
  for (const f of PLUGIN_TEXTS) assert.doesNotMatch(read(f), /Importer/, f);
});

test('install lines are the two-step marketplace form, never the one-line --marketplace form', () => {
  for (const f of ['README.md', 'packages/claude-code/README.md', 'packages/claude-code/skills/connect/SKILL.md']) {
    const t = read(f);
    assert.doesNotMatch(t, /--marketplace/, f);
    assert.match(t, /\/plugin marketplace add wybe-labs\/wybe-connect\n\s*\/plugin install wybe-connect@wybe-connect/, f);
  }
  assert.match(readme, /codex plugin marketplace add wybe-labs\/wybe-connect\ncodex plugin add wybe-connect@wybe-connect/);
});
