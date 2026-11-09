// Copies lib/*.js into packages/<harness>/lib/ for every package. Claude Code, Codex and Cursor
// all install a plugin by copying only the plugin's own directory into their cache, so a plugin
// cannot reach ../../lib at runtime; each ships a byte-identical copy, and test/lib-sync.test.js
// fails when any copy drifts. Run: npm run sync-lib

import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = ['claude-code', 'codex', 'cursor'];

const root = join(import.meta.dirname, '..');
const src = join(root, 'lib');
const files = readdirSync(src).filter((f) => f.endsWith('.js'));
for (const pkg of PACKAGES) {
  const dst = join(root, 'packages', pkg, 'lib');
  mkdirSync(dst, { recursive: true });
  for (const f of files) writeFileSync(join(dst, f), readFileSync(join(src, f)));
  // a module removed from lib/ must disappear from the copies too
  for (const f of readdirSync(dst)) {
    if (f.endsWith('.js') && !files.includes(f)) unlinkSync(join(dst, f));
  }
  process.stdout.write(`sync-lib: ${files.length} file(s) copied to packages/${pkg}/lib\n`);
}
