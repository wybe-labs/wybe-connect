// A LIVE but slow holder of the distil lock (QA R4-7's shape; not claude): takes the lock through
// the real lib/lock.js, reads distil.json, stays inside its critical section for <hold ms> (a laptop
// that slept mid-hook, an AV scan, a loaded disk), then writes what it read plus one entry of its
// own. argv: <home root> <hold ms>. Prints "HOLDING" once it has the lock, "HOLDER done" at the end.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = (f) => import(pathToFileURL(join(import.meta.dirname, '..', '..', 'packages', 'claude-code', 'lib', f)).href);
const [root, holdMs] = process.argv.slice(2);
if (!root) process.exit(0); // picked up by `node --test` as a file
const D = await lib('distil.js');
const { withLock } = await lib('lock.js');
const { paths, writeJsonPrivate } = await lib('home.js');
const p = paths(root);
const dp = D.distilPaths(p);
const got = withLock(dp.lock, () => {
  const s = D.loadState(p);
  process.stdout.write('HOLDING\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  s.pending.push({ path: 'C:\\holder\\written-after-the-pause.jsonl', sessionId: null, cwd: null, notedAt: new Date().toISOString() });
  writeJsonPrivate(dp.state, s);
  return 'done';
}, { tries: 400 });
process.stdout.write(`HOLDER ${got}\n`);
