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
