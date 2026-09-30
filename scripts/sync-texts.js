// Renders texts/standing.json into the root README between the texts markers. The JSON is the
// source (the node's connect cards pin against it); the README copy is generated, and
// test/texts.test.js fails when the two differ. Run: npm run sync-texts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- texts:begin (generated from texts/standing.json by `npm run sync-texts`; edit the JSON, not this block) -->';
export const END = '<!-- texts:end -->';

const ROOT = join(import.meta.dirname, '..');

export function renderTexts(t) {
  const both = (pair) => ['**Norsk**', '', `> ${pair.nb}`, '', '**English**', '', `> ${pair.en}`];
  const steps = (pair) => ['**Norsk**', '', ...pair.nb.map((s, i) => `${i + 1}. ${s}`), '', '**English**', '', ...pair.en.map((s, i) => `${i + 1}. ${s}`)];
  return [
    BEGIN,
    '',
    '### Fast instruks / Standing instruction',
    '',
    ...both(t.standing),
    '',
    '### Synk-melding / Sync prompt',
    '',
    ...both(t.sync),
    '',
    '### Claude Desktop / claude.ai',
    '',
    ...steps(t.setup.claude_desktop),
    '',
    '### ChatGPT',
    '',
    ...steps(t.setup.chatgpt),
    '',
    END,
  ].join('\n');
}

export function readmeBlock(readme) {
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) return null;
  return readme.slice(a, b + END.length);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const texts = JSON.parse(readFileSync(join(ROOT, 'texts', 'standing.json'), 'utf8'));
  const path = join(ROOT, 'README.md');
  const readme = readFileSync(path, 'utf8');
  const block = readmeBlock(readme);
  if (!block) throw new Error('README.md has no texts markers');
  writeFileSync(path, readme.replace(block, renderTexts(texts)));
  process.stdout.write('sync-texts: README.md updated from texts/standing.json\n');
}
