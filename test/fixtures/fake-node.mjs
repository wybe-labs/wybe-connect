// A fake node for the session bridge tests, on 127.0.0.1: the MCP door's inbox, sessions_report and
// task_result in the shapes the node ships, plus the token endpoint for a refresh. Every call is
// recorded with its bearer and raw body, so a test can check what left the machine.
import { createServer } from 'node:http';

export const TOKEN = ['wat_', 'b1Rr2Dd3Gg4Ee5Bb6Rr7Ii8Dd9Gg0Ee1Tt2Kk3Nn'].join('');
export const REFRESH = ['wrt_', 'r1Ee2Ff3Rr4Ee5Ss6Hh7Tt8Oo9Kk0Ee1Nn'].join('');
export const NEW_TOKEN = ['wat_', 'n9Ee8Ww7Tt6Oo5Kk4Ee3Nn2Vv1Aa0Ll9Uu8Ee'].join('');

export function startFakeNode({ valid = TOKEN, level = 'write' } = {}) {
  const node = {
    level,
    valid,
    down: false,
    busy: null, // 'retry' | 'text': task_result refuses for now (see below)
    tasks: [], // { id, text, mode, session_id, created_at, expires_at }
    results: new Map(),
    calls: [], // { name, args, auth, body }
    bodies: [],
    refreshes: 0,
    // 'revoked': the token endpoint answers 400 invalid_grant; 'flaky': it answers 503; 'rotating': an
    // authorization server with rotating refresh tokens and reuse detection (see below)
    grant: 'live',
    refresh: REFRESH, // 'rotating': the one refresh token it accepts now
    generation: 0, // 'rotating': how many times it rotated
    reused: 0, // 'rotating': refreshes that presented a refresh token it had already rotated
    presented: [], // every refresh token presented to the token endpoint
    tokenDelayMs: 0, // how long the token endpoint takes to answer
    requests: 0, // MCP requests (everything but the token endpoint)
    tool: (name) => node.calls.filter((c) => c.name === name),
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      node.bodies.push(body);
      if (node.down) { res.writeHead(503).end(); return; }
      if (req.url === '/oauth/token') {
        node.refreshes += 1;
        const presented = new URLSearchParams(body).get('refresh_token');
        node.presented.push(presented);
        const answer = (status, json) => setTimeout(() => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json)), node.tokenDelayMs);
        if (node.grant === 'rotating') {
          // Each refresh token works once. One presented again after it was rotated is taken as stolen:
          // the whole grant is revoked (every token of it, the new ones too), as the authorization server does.
          if (presented !== node.refresh) {
            node.reused += 1;
            node.grant = 'revoked';
            node.valid = 'wat_nobody-has-this';
            answer(400, { error: 'invalid_grant' });
            return;
          }
          node.generation += 1;
          node.refresh = `wrt_rotated-${node.generation}`;
          node.valid = `wat_rotated-${node.generation}`;
          answer(200, { access_token: node.valid, token_type: 'Bearer', expires_in: 3600, refresh_token: node.refresh, scope: 'remember sessions:light' });
          return;
        }
        if (node.grant === 'revoked') { answer(400, { error: 'invalid_grant' }); return; }
        if (node.grant === 'flaky') { res.writeHead(503).end(); return; }
        node.valid = NEW_TOKEN;
        answer(200, { access_token: NEW_TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: REFRESH, scope: 'remember sessions:light' });
        return;
      }
      node.requests += 1;
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      if (req.headers.authorization !== `Bearer ${node.valid}`) { res.writeHead(401).end(); return; }
      const msg = JSON.parse(body);
      const reply = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })); return; }
      if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      if (msg.method !== 'tools/call') { reply({ tools: [] }); return; }
      const { name, arguments: args = {} } = msg.params;
      node.calls.push({ name, args, auth: req.headers.authorization, body });
      const text = (o, isError = false) => reply({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }], ...(isError ? { isError: true } : {}) });
      if (name === 'inbox') {
        const tasks = node.level === 'read' ? [] : node.tasks.filter((t) => !node.results.has(t.id) && (!t.session_id || t.session_id === args.session_id));
        text({ ok: true, level: node.level, acked: (args.ack ?? []).length, tasks: tasks.map((t) => ({ from: 'KI-kollega', created_at: '2026-01-01T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', session_id: null, ...t })) });
        return;
      }
      if (name === 'sessions_report') { text({ ok: true, known: (args.sessions ?? []).length }); return; }
      if (name === 'task_result') {
        // busy: 'retry' answers the refusal with structuredContent { retry: true } and a text that does not say so;
        // 'text' answers with only the words. Either way nothing is stored.
        if (node.busy === 'retry') { reply({ content: [{ type: 'text', text: 'Refused.' }], structuredContent: { retry: true }, isError: true }); return; }
        if (node.busy === 'text') { text('Too many results right now; try again later.', true); return; }
        if (node.results.has(args.task_id)) { text('No such task for this session.', true); return; }
        node.results.set(args.task_id, args);
        text({ ok: true });
        return;
      }
      text(`unknown tool ${name}`, true);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    node.base = `http://127.0.0.1:${server.address().port}`;
    node.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    resolve(node);
  }));
}

/** A grant for the fake node, in the shape lib/home.js stores. */
export function grantFor(node, over = {}) {
  return {
    version: 1, nodeUrl: node.base, resource: `${node.base}/mcp`, mcpEndpoint: `${node.base}/mcp`, issuer: node.base, tokenEndpoint: `${node.base}/oauth/token`,
    clientId: 'c-test', accessToken: TOKEN, refreshToken: REFRESH, expiresAt: null, scopes: ['remember', 'sessions:light'], grantId: 'g1', ...over,
  };
}
