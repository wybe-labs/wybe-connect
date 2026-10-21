// A LIVE but slow holder of distil.lock (NOT claude): takes the lock through the real withLock, reads
// distil.json, stays inside its critical section for HOLD_MS (a laptop that slept mid-hook, an AV
// scan of the write, a loaded disk), then writes what it read plus one entry of its own.
// argv: <home root> <hold ms>. Prints "HOLDING" once it has the lock.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = join(import.meta.dirname, '..', '..');
const lib = (f) => import(pathToFileURL(join(REPO, 'packages', 'claude-code', 'lib', f)).href);
const D = await lib('distil.js');
const { paths, writeJsonPrivate } = await lib('home.js');
const [root, holdMs] = process.argv.slice(2);
if (!root) process.exit(0); // picked up by `node --test` as a file
const p = paths(root);
const got = D.withLock(p, () => {
  const s = D.loadState(p);
  process.stdout.write('HOLDING\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  s.pending.push({ transcriptPath: 'C:\\holder\\written-after-the-pause.jsonl', sessionId: null, cwd: null, at: new Date().toISOString() });
  writeJsonPrivate(join(p.state, 'distil.json'), s);
  return 'done';
}, { tries: 400 });
process.stdout.write(`HOLDER ${got}\n`);
