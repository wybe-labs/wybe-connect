import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Claude Code installs a marketplace plugin by copying only the plugin directory, so the plugin
// ships its own copy of lib/. This test is the guard that keeps the copy byte-identical; the
// hook tests run the copy, the unit tests run the original. Fix a drift with: npm run sync-lib

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'lib');
const DST = join(ROOT, 'packages', 'claude-code', 'lib');

test('packages/claude-code/lib is a byte-identical copy of lib (whole set, both directions)', () => {
  const src = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
  assert.ok(src.length >= 8, 'the shared lib has its modules');
  assert.ok(existsSync(DST), 'the plugin copy exists (npm run sync-lib)');
  const dst = readdirSync(DST).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(dst, src, 'same file set');
  for (const f of src) {
    assert.ok(readFileSync(join(SRC, f)).equals(readFileSync(join(DST, f))), `${f} drifted; run npm run sync-lib`);
  }
});
