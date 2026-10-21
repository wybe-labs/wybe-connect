import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDelivery, newSummary } from '../lib/flush.js';
import { paths } from '../lib/home.js';

const NODE = 'https://demo.wybe.me';
const TOKEN_ENDPOINT = 'https://auth.wybe.me/oauth/token';

/** The node refuses the first bearer (401), so the delivery refreshes once; records the refresh form. */
function refusingNode() {
  const forms = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url) === TOKEN_ENDPOINT) {
      forms.push(Object.fromEntries(new URLSearchParams(init.body)));
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 401 });
  };
  return { forms, fetchImpl };
}

for (const [label, extra, expected] of [
  ['a credential that stored its resource refreshes for exactly it', { resource: `${NODE}/mcp` }, `${NODE}/mcp`],
  ['a credential from before `resource` was stored refreshes for the /mcp endpoint, never the bare origin', {}, `${NODE}/mcp`],
]) {
  test(`refresh: ${label}`, async () => {
    const node = refusingNode();
    const credentials = { version: 1, nodeUrl: NODE, mcpEndpoint: `${NODE}/mcp`, tokenEndpoint: TOKEN_ENDPOINT, clientId: 'c1', accessToken: 'wat_x', refreshToken: 'wrt_y', scopes: ['sessions:light'], ...extra };
    const p = paths(mkdtempSync(join(tmpdir(), 'wybe-connect-refresh-')));
    const summary = newSummary('Stop');
    const { deliver } = createDelivery({ credentials, paths: p, fetchImpl: node.fetchImpl, summary });
    await deliver({ scope: 'sessions:light', turns: [] });
    assert.equal(node.forms.length, 1, 'one refresh attempt');
    assert.equal(node.forms[0].resource, expected);
    assert.equal(summary.queued, 1, 'refused: queued, not lost');
  });
}
