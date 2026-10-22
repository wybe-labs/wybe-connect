// The connect skills. The node starts the first sync by itself when the connection is made
// (wybe-node #827/#846: an `import_request`), so a skill must not run a second one: the node's
// knowledge write has no dedupe, and an interview at connect stored every fact twice (QA F1 on
// wybe-node #846). «Run one-time setup work (import, first sync) automatically on connect; never
// add a button for it» Oscar 2026-10-22, relayed by the Desk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

for (const pkg of ['claude-code', 'codex', 'cursor']) {
  test(`${pkg}: the connect skill runs no first sync of its own; the node's import is the only one`, () => {
    const skill = readFileSync(join(ROOT, 'packages', pkg, 'skills', 'connect', 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /opening kit/i, 'no opening-kit interview');
    assert.doesNotMatch(skill, /run the first sync/i, 'the skill does not run a first sync');
    const steps = skill.slice(skill.indexOf('## Steps'), skill.indexOf('## Never'));
    assert.doesNotMatch(steps, /call the `wybe` server's `remember`/i, 'no remember call while connecting');
    assert.match(skill, /import/i, 'it says the import is the first sync, started by the node');
  });
}
