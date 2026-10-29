// Child for test/connections.test.js: dies (exit 9) at the CRASH_AT-th renameSync inside
// migrateLegacy(MIGRATE_ROOT), the way a killed hook would.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const crashAt = Number(process.env.CRASH_AT);
const orig = fs.renameSync;
let n = 0;
fs.renameSync = (a, b) => {
  n += 1;
  if (n === crashAt) process.exit(9);
  return orig(a, b);
};
syncBuiltinESMExports();
const { migrateLegacy } = await import('../../lib/connections.js');
migrateLegacy(process.env.MIGRATE_ROOT);
