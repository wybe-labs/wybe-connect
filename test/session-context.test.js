import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, questionText, STANDING_INSTRUCTION } from '../lib/session-context.js';

const credentials = { nodeUrl: 'https://demo.example.test', scopes: ['remember'] };

test('SessionStart: the node\'s open questions carry `question` ({id, question}) and reach Claude', () => {
  const ctx = buildContext({ credentials, cached: { open_questions: [{ id: 'q-1', question: 'Hvilket prosjekt er viktigst nå?' }] } });
  assert.ok(ctx.includes(STANDING_INSTRUCTION));
  assert.ok(ctx.includes('- (q-1) Hvilket prosjekt er viktigst nå?'));
});

test('questionText: `question` first, then the older `text`, else nothing', () => {
  assert.equal(questionText({ id: 'a', question: 'Q?' }), 'Q?');
  assert.equal(questionText({ id: 'a', text: 'T?' }), 'T?');
  assert.equal(questionText({ id: 'a', question: 'Q?', text: 'T?' }), 'Q?');
  assert.equal(questionText({ id: 'a' }), null);
  assert.equal(questionText(null), null);
  assert.equal(buildContext({ credentials, cached: { open_questions: [{ id: 'x' }] } }).includes('open questions'), false);
});
