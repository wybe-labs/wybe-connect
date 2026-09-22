// Copies lib/*.js into packages/claude-code/lib/. Claude Code installs a marketplace plugin by
// copying only the plugin's own directory into its cache, so the plugin cannot reach ../../lib
// at runtime; it ships a byte-identical copy, and test/lib-sync.test.js fails when the two
// drift. Run: npm run sync-lib

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const src = join(root, 'lib');
const dst = join(root, 'packages', 'claude-code', 'lib');
mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (!f.endsWith('.js')) continue;
  writeFileSync(join(dst, f), readFileSync(join(src, f)));
  n += 1;
}
process.stdout.write(`sync-lib: ${n} file(s) copied to packages/claude-code/lib\n`);
