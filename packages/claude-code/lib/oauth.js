// OAuth 2.1 authorization-code flow with PKCE for a public client, dependency-free:
//   discover   the node's protected-resource metadata names the authorization server, whose
//              RFC 8414 document names the endpoints (S256 required)
//   loopback   a one-shot http server on 127.0.0.1:<random port> receives the code
//   register   RFC 7591 dynamic registration with exactly that loopback redirect_uri
//   browser    opened by spawning the platform opener with the URL as an argument (never a shell)
//   exchange   code + verifier -> access + refresh tokens (RFC 8707 `resource` = the node)
//   refresh    rotating refresh token
// Tokens are returned to the caller; this module stores nothing and logs nothing but the URL to
// open (which carries the public challenge and state, never a token).

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export const DEFAULT_ISSUER = 'https://auth.wybe.me';
export const ALL_SCOPES = Object.freeze(['remember', 'conversations', 'sessions:light', 'sessions:full']);
const REQUIRED_METADATA = ['issuer', 'authorization_endpoint', 'token_endpoint', 'code_challenge_methods_supported'];

async function getJson(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function discover(nodeUrl, { fetchImpl = globalThis.fetch, fallbackIssuer = DEFAULT_ISSUER, timeoutMs = 10_000 } = {}) {
  const origin = new URL(nodeUrl).origin;
  if (!origin.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(origin)) {
    throw new Error('the node URL must be https (or loopback for tests)');
  }
  const mcpEndpoint = `${origin}/mcp`;
  let issuer = fallbackIssuer;
  let resourceScopes = null;
  try {
    const prm = await getJson(fetchImpl, `${origin}/.well-known/oauth-protected-resource`, timeoutMs);
    if (Array.isArray(prm.authorization_servers) && typeof prm.authorization_servers[0] === 'string') issuer = prm.authorization_servers[0];
    if (Array.isArray(prm.scopes_supported)) resourceScopes = prm.scopes_supported;
  } catch {
    // an older node without the document: the issuer is the ruled one
  }
  const metadata = await getJson(fetchImpl, `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`, timeoutMs);
  for (const k of REQUIRED_METADATA) {
    if (!(k in metadata)) throw new Error(`authorization server metadata lacks ${k}`);
  }
  if (!metadata.code_challenge_methods_supported.includes('S256')) throw new Error('authorization server does not support PKCE S256');
  return { resource: origin, mcpEndpoint, issuer: metadata.issuer, metadata, resourceScopes };
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function register({ metadata, redirectUri, scopes, fetchImpl = globalThis.fetch, clientName = 'wybe-connect (Claude Code)', timeoutMs = 10_000 }) {
  if (typeof metadata.registration_endpoint !== 'string') throw new Error('authorization server offers no registration endpoint');
  const res = await fetchImpl(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: scopes.join(' '),
      software_id: 'wybe-labs/wybe-connect',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`registration refused: HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.client_id !== 'string') throw new Error('registration answered without a client_id');
  return { clientId: body.client_id };
}

export function authorizeUrl({ metadata, clientId, redirectUri, scopes, state, challenge, resource }) {
  const u = new URL(metadata.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('resource', resource);
  return u.toString();
}

async function tokenRequest(tokenEndpoint, form, fetchImpl, timeoutMs) {
  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let reason = '';
    try {
      const err = await res.json();
      reason = typeof err?.error === 'string' ? ` (${err.error})` : '';
    } catch {
      // no JSON body
    }
    throw new Error(`token endpoint refused: HTTP ${res.status}${reason}`);
  }
  const body = await res.json();
  if (typeof body.access_token !== 'string') throw new Error('token endpoint answered without an access_token');
  return body;
}

function tokensToCredentials(body, { requestedScopes, now }) {
  const { refresh_token: refreshToken, expires_in: expiresIn, scope, access_token: accessToken } = body;
  const scopes = typeof scope === 'string' && scope.trim() ? scope.trim().split(/\s+/) : [...requestedScopes];
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : null,
    expiresAt: typeof expiresIn === 'number' ? new Date(now + expiresIn * 1000).toISOString() : null,
    scopes,
  };
}

export async function exchangeCode({ metadata, clientId, code, verifier, redirectUri, resource, requestedScopes, fetchImpl = globalThis.fetch, timeoutMs = 10_000, now = Date.now() }) {
  const body = await tokenRequest(metadata.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  }, fetchImpl, timeoutMs);
  return tokensToCredentials(body, { requestedScopes, now });
}

/** Rotates the refresh token. Returns the new token fields, or null when the grant is gone. */
export async function refreshTokens({ tokenEndpoint, clientId, refreshToken, resource, requestedScopes, fetchImpl = globalThis.fetch, timeoutMs = 10_000, now = Date.now() }) {
  if (!refreshToken) return null;
  try {
    const body = await tokenRequest(tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource,
    }, fetchImpl, timeoutMs);
    const next = tokensToCredentials(body, { requestedScopes, now });
    if (!next.refreshToken) next.refreshToken = refreshToken;
    return next;
  } catch {
    return null;
  }
}

const DONE_PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * Starts the one-shot loopback receiver. `redirectUri` resolves once listening; `result`
 * resolves with { code } when the callback arrives with the expected state, rejects on an
 * OAuth error, a state mismatch, or the timeout. Always closes itself.
 */
export function startLoopback({ expectedState, host = '127.0.0.1', port = 0, timeoutMs = 5 * 60_000 }) {
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  result.catch(() => {}); // a refusal may land before the caller awaits; it is still delivered to the caller, just never "unhandled"
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (error) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE('Ikke koblet til / Not connected', `The authorization server answered: ${escapeHtml(error)}. You can close this tab.`));
      finish(new Error(`authorization refused: ${error}`));
      return;
    }
    if (state !== expectedState || !code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE('Ugyldig svar / Invalid callback', 'The callback did not match this connect attempt. Close this tab and run connect again.'));
      finish(new Error('callback state mismatch'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE('Koblet til Wybe / Connected to Wybe', 'You can close this tab and go back to your terminal.'));
    finish(null, { code });
  });
  const timer = setTimeout(() => finish(new Error(`no callback within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  let done = false;
  function finish(err, value) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    if (err) settle.reject(err);
    else settle.resolve(value);
  }
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(`http://${host}:${server.address().port}/callback`));
  });
  return { redirectUri: listening, result, close: () => finish(new Error('closed')) };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Opens the URL in the person's browser by spawning the platform opener; the URL is an argument, never shell text. */
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const [cmd, args] = platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * The whole flow. Returns credentials ready for saveCredentials(): node, endpoints, client id,
 * tokens, granted scopes. `log(line)` receives progress lines (no token ever passes through it).
 * `clientName` names the harness on the consent screen and in the node's pairing list; each
 * harness registers its own client (one pairing per assistant).
 */
export async function connect(nodeUrl, { scopes = ALL_SCOPES, clientName = 'wybe-connect (Claude Code)', fetchImpl = globalThis.fetch, spawnImpl = spawn, platform = process.platform, timeoutMs = 5 * 60_000, log = () => {}, now = Date.now } = {}) {
  const d = await discover(nodeUrl, { fetchImpl });
  log(`authorization server: ${d.issuer}`);
  const state = randomBytes(16).toString('base64url');
  const { verifier, challenge } = pkcePair();
  const loop = startLoopback({ expectedState: state, timeoutMs });
  const redirectUri = await loop.redirectUri;
  let clientId;
  try {
    ({ clientId } = await register({ metadata: d.metadata, redirectUri, scopes, fetchImpl, clientName }));
  } catch (err) {
    loop.close();
    throw err;
  }
  const url = authorizeUrl({ metadata: d.metadata, clientId, redirectUri, scopes, state, challenge, resource: d.resource });
  const opened = openBrowser(url, { platform, spawnImpl });
  log(opened ? `browser opened; if nothing appeared, open this URL yourself:\n${url}` : `open this URL in your browser:\n${url}`);
  const { code } = await loop.result;
  const tokens = await exchangeCode({ metadata: d.metadata, clientId, code, verifier, redirectUri, resource: d.resource, requestedScopes: scopes, fetchImpl, now: now() });
  return {
    nodeUrl: d.resource,
    mcpEndpoint: d.mcpEndpoint,
    issuer: d.issuer,
    tokenEndpoint: d.metadata.token_endpoint,
    clientId,
    connectedAt: new Date(now()).toISOString(),
    ...tokens,
  };
}
