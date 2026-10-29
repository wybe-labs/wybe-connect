// Seeds a sandbox Claude Code home for the opt-in live distil test (test/live/distil-live.test.js):
//   node test/live/seed.mjs <CLAUDE_CONFIG_DIR>
// It writes 3 synthetic projects, each with its working folder beside the home, one transcript of
// each project's work, and:
//   - one transcript whose time is 60 days back, so the import shows it has no age window
//   - planted values the node must never store: a fake wat_ token, an example.invalid address, and
//     a synthetic fødselsnummer (month + 80, the test-number series) with valid control digits
//   - a MEMORY.md under projects/<dir>/memory and a CLAUDE.md in the home
// Everything is made up. It writes live-seed.json in the home: what the live test checks against.
// Picked up by `node --test` as a file (no argument), it does nothing.
import { mkdirSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const home = process.argv[2] ? resolve(process.argv[2]) : null;
if (!home) process.exit(0);
if (existsSync(join(home, 'projects')) && readdirSync(join(home, 'projects')).length) {
  process.stderr.write(`seed: ${join(home, 'projects')} is not empty; use a fresh sandbox home\n`);
  process.exit(1);
}

/** A synthetic fødselsnummer: day, month + 80 (never a real person's), year, then valid control digits. */
export function syntheticFnr(day = 15, month = 1, year = 90) {
  const two = (n) => String(n).padStart(2, '0');
  const w1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
  const w2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const control = (digits, w) => { const r = 11 - (digits.reduce((s, d, i) => s + d * w[i], 0) % 11); return r === 11 ? 0 : r; };
  for (let ind = 100; ind < 500; ind++) {
    const base = `${two(day)}${two(month + 80)}${two(year)}${ind}`.split('').map(Number);
    const k1 = control(base, w1);
    if (k1 === 10) continue;
    const k2 = control([...base, k1], w2);
    if (k2 === 10) continue;
    return [...base, k1, k2].join('');
  }
  throw new Error('no synthetic number found');
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const token = ['wat', 'L1vE'.repeat(10)].join('_');
const email = 'kari.demo@example.invalid';
const fnr = syntheticFnr();
const work = join(dirname(home), `${home.split(/[\\/]/).pop()}-work`);

const PROJECTS = [
  { name: 'harbor-billing', ageDays: 60, ask: 'Move the invoice export to a nightly job and keep the CSV format the accountants use.', answer: 'Done: the export runs at 02:00 and writes the same CSV columns.' },
  { name: 'tide-sensors', ageDays: 3, ask: `The sensor gateway token is ${token}; use it to fetch the last day of readings and chart the outliers.`, answer: 'Charted 12 outliers; they all come from one gateway with a drifting clock.' },
  { name: 'pier-booking', ageDays: 1, ask: `Add a booking contact field. A test customer is ${email}, personal number ${fnr}.`, answer: 'Added the contact field with validation; the test customer books berth 7.' },
];

const encode = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const seeded = [];
for (const p of PROJECTS) {
  const cwd = join(work, p.name);
  mkdirSync(cwd, { recursive: true });
  const dir = join(home, 'projects', encode(cwd));
  mkdirSync(dir, { recursive: true });
  const sessionId = randomUUID();
  const at = (s) => new Date(now - p.ageDays * DAY + s * 1000).toISOString();
  const base = { isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.0' };
  const lines = [
    { ...base, type: 'user', uuid: 'u-1', parentUuid: null, timestamp: at(0), message: { role: 'user', content: p.ask } },
    { ...base, type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', timestamp: at(30), message: { role: 'assistant', content: [{ type: 'text', text: p.answer }] } },
  ];
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const t = new Date(now - p.ageDays * DAY);
  utimesSync(file, t, t);
  seeded.push({ project: p.name, transcript: file, lines: lines.length, ageDays: p.ageDays });
}

const memory = join(home, 'projects', encode(join(work, 'tide-sensors')), 'memory', 'MEMORY.md');
mkdirSync(dirname(memory), { recursive: true });
writeFileSync(memory, '- The tide-sensors gateways report every 5 minutes; a gap over 20 minutes is an outage.\n');
const claudeMd = join(home, 'CLAUDE.md');
writeFileSync(claudeMd, 'Prefer small pull requests with a test first.\n');

const manifest = { home, work, seeded, memory: [claudeMd, memory], planted: [token, email, fnr] };
writeFileSync(join(home, 'live-seed.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`seed: ${seeded.length} projects in ${home}; one transcript ${PROJECTS[0].ageDays} days old\n`);
