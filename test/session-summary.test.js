// The background distil writes a short summary of each session it reads, so the colleague can say
// what every session is about: the summary stays on this machine (lib/session-scan.js) and goes to
// the node only inside sessions_report, never as a fact and never as transcript text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy } from '../lib/mcp-proxy.js';
import { paths } from '../lib/home.js';
import { distilPaths, buildPrompt } from '../lib/distil.js';
import { readRecords } from '../lib/ledger.js';
import { summaryOf } from '../lib/session-scan.js';

const req = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '22222222-3333-4444-8555-666666666666';
const PLANTED = ['postgres://app:', 'Pl4nted-Pw', '@db.example.test/x'].join('');

function run(runId = 'r-sum-1') {
  const p = paths(mkdtempSync(join(tmpdir(), 'wybe-connect-summary-')));
  const dp = distilPaths(p);
  mkdirSync(dp.runs, { recursive: true });
  const plan = { runId, mode: 'ongoing', connection: null, transcripts: [
    { path: '/home/eier/.claude/projects/-w-atlas/a.jsonl', sessionId: S1, fromLine: 0, toLine: 10 },
    { path: '/home/eier/.claude/projects/-w-crm/b.jsonl', sessionId: S2, fromLine: 4, toLine: 9 },
  ] };
  writeFileSync(dp.plan(runId), JSON.stringify(plan));
  const proxy = createProxy({ paths: p, distilRun: runId, fetchImpl: async () => { throw new Error('no network expected'); } });
  return { p, plan, proxy, runId };
}

test('distil run: a remember item with the session_id of a session in the run is that session\'s summary, kept here redacted, never a fact', async () => {
  const { p, proxy, runId } = run();
  const r = await proxy.handle(req(1, 'tools/call', { name: 'remember', arguments: { items: [
    { session_id: S1, category: 'session-summary', content: `Adds a retry with backoff to the ingest queue, tested against ${PLANTED}.` },
    { content: 'The person prefers small PRs, one concern each.', category: 'preference' },
  ] } }));
  assert.equal(r.result.isError, undefined);
  assert.match(summaryOf(p, S1), /^Adds a retry with backoff to the ingest queue/);
  assert.ok(!summaryOf(p, S1).includes('Pl4nted-Pw'));
  const { records } = readRecords(distilPaths(p).outbox(runId));
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].args.items.map((i) => i.content), ['The person prefers small PRs, one concern each.'], 'only the fact is queued for the node');

  // a call of summaries only queues nothing for the node
  await proxy.handle(req(2, 'tools/call', { name: 'remember', arguments: { items: [{ session_id: S2, content: 'Renames the pipeline stages in the CRM.' }] } }));
  assert.equal(summaryOf(p, S2), 'Renames the pipeline stages in the CRM.');
  assert.equal(readRecords(distilPaths(p).outbox(runId)).records.length, 1);
  assert.match((await proxy.handle(req(3, 'tools/call', { name: 'distil_done', arguments: {} }))).result.content[0].text, /1 remember call/);
});

test('distil run: a summary for a session the run did not read is refused, and nothing is stored', async () => {
  const { p, proxy, runId } = run();
  const r = await proxy.handle(req(1, 'tools/call', { name: 'remember', arguments: { items: [{ session_id: 'not-in-this-run', content: 'Something.' }, { content: 'A fact.' }] } }));
  assert.equal(r.result.isError, true);
  assert.equal(summaryOf(p, 'not-in-this-run'), null);
  assert.equal(readRecords(distilPaths(p).outbox(runId)).records.length, 0);
});

test('distil run: remember\'s schema offers session_id on an item', async () => {
  const { proxy } = run();
  const remember = (await proxy.handle(req(1, 'tools/list'))).result.tools.find((t) => t.name === 'remember');
  assert.equal(remember.inputSchema.properties.items.items.properties.session_id.type, 'string');
});

test('the prompt names each range\'s session and asks for one short summary per session, sent with session_id', () => {
  const { plan } = run();
  const prompt = buildPrompt(plan);
  assert.ok(prompt.includes(`- ${S1}: `) && prompt.includes(`- ${S2}: `));
  assert.match(prompt, /^- \S+\.jsonl lines 1-10$/m, 'the range lines keep their form');
  assert.match(prompt, /one short summary of each session/i);
  assert.match(prompt, /session_id/);
  assert.match(prompt, /never sent as a fact/i);
});
