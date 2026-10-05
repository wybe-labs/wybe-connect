import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Every harness installs its plugin by copying only the plugin directory, so each package ships
// its own copy of lib/. This test is the guard that keeps every copy byte-identical; the hook
// tests run the copies, the unit tests run the original. Fix a drift with: npm run sync-lib

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'lib');
const PACKAGES = ['claude-code', 'codex', 'cursor'];

for (const pkg of PACKAGES) {
  test(`packages/${pkg}/lib is a byte-identical copy of lib (whole set, both directions)`, () => {
    const dstDir = join(ROOT, 'packages', pkg, 'lib');
    const src = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
    assert.ok(src.length >= 11, 'the shared lib has its modules');
    assert.ok(existsSync(dstDir), `the ${pkg} copy exists (npm run sync-lib)`);
    const dst = readdirSync(dstDir).filter((f) => f.endsWith('.js')).sort();
    assert.deepEqual(dst, src, 'same file set');
    for (const f of src) {
      assert.ok(readFileSync(join(SRC, f)).equals(readFileSync(join(dstDir, f))), `${pkg}/lib/${f} drifted; run npm run sync-lib`);
    }
  });
}
