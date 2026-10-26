// Laptop-side redaction: deterministic, dependency-free, no LLM (an LLM can itself leak). Every
// string that leaves the machine passes through redact(); the original is never logged or kept.
// Three layers, run as FAMILIES in order: (1) STRUCTURE: PEM blocks, YAML block scalars, URL
// userinfo, Authorization headers, cookies and CLI flags are read by shape; (2) known vendor token
// PREFIXES go wherever they stand; (3) the KEY pass finds key/value pairs (JSON at any escape
// depth, YAML, env and shell assignments, headers, URL query, connection strings) and judges the
// key: a value under a secret key goes unless it is a placeholder, type, code, path, label or
// sentence, and an id-like key (page_token, cache_key) vouches for its value; last, an ENTROPY
// check takes long random strings nothing vouched for. Tags read [REDACTED:<family>] and a second
// pass changes nothing. test/redact-table.test.js freezes every leak and false positive.

const TAG_RE = /\[REDACTED:[a-z-]+\]/g;
const B = '(?<![A-Za-z0-9_-])'; // left boundary that refuses to start inside a longer token
const E = '(?![A-Za-z0-9_-])'; // right boundary

// ------------------------------------------------------------------ key classification

const CONFUSABLES = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ԝ': 'w', 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'ο': 'o', 'α': 'a', 'ρ': 'p', 'ν': 'v', 'τ': 't', 'ι': 'i', 'κ': 'k', 'Ο': 'O', 'Α': 'A', 'Ρ': 'P', 'Τ': 'T', 'Κ': 'K', 'Ε': 'E' };
const TRANSLATE = { passord: 'password', passordet: 'password', passwort: 'password', wachtwoord: 'password', losenord: 'password', 'lösenord': 'password', salasana: 'password', kodeord: 'password', adgangskode: 'password', hemmelighet: 'secret', hemmelig: 'secret', geheimnis: 'secret', 'nøkkel': 'key', nokkel: 'key', 'schlüssel': 'key', nyckel: 'key' };
const PASSWORD_WORDS = new Set(['password', 'passwd', 'pwd', 'passphrase']);
const SECRET_WORDS = new Set(['secret', 'token', 'credential', 'credentials', 'signature', 'sig', 'apikey']);
/** A key ending in one of these names a property of a secret, not the secret (password_min_length, secret_name). */
const NOT_LAST = new Set(['file', 'path', 'dir', 'folder', 'env', 'var', 'name', 'names', 'id', 'ids', 'arn', 'ref', 'uri', 'url', 'endpoint', 'host', 'length', 'len', 'min', 'max', 'policy', 'hint', 'reset', 'expiry', 'expires', 'expiration', 'ttl', 'lifetime', 'count', 'type', 'types', 'field', 'label', 'header', 'prompt', 'regex', 'pattern', 'rule', 'rules', 'required', 'strength', 'mode', 'format', 'enabled', 'disabled', 'changed', 'updated', 'created', 'at', 'version', 'algorithm', 'alg', 'kind', 'size', 'bits', 'usage', 'limit', 'budget', 'provider', 'manager', 'store', 'backend', 'engine', 'namespace', 'scope', 'scopes', 'owner', 'location', 'source', 'rotation', 'stdin', 'command', 'cmd', 'helper', 'error', 'errors', 'message', 'text', 'title', 'placeholder', 'description', 'help', 'input', 'output', 'visible', 'status', 'state', 'method', 'methods', 'salt']);
const NOT_FIRST = new Set(['max', 'min', 'num', 'total', 'n']);
/** <x>_token where x makes it a cursor or a counter, not a credential. */
const NOT_TOKEN_PREFIX = new Set(['page', 'next', 'cursor', 'continuation', 'sync', 'pagination', 'resume', 'delta', 'change', 'input', 'output', 'completion', 'prompt', 'total', 'max', 'num', 'start', 'end', 'sequence', 'batch', 'offset', 'idempotency', 'cache', 'reasoning']);
/** <x>_key where x makes it an identifier, not a credential. */
const NOT_KEY_PREFIX = new Set(['idempotency', 'idem', 'partition', 'primary', 'foreign', 'sort', 'cache', 'public', 'object', 'thumbnail', 'row', 'hash', 'range', 'shard', 'routing', 'dedup', 'dedupe', 'deduplication', 'lookup', 'unique', 'composite', 'natural', 'surrogate', 'file', 'image', 'map', 'group', 'order', 'index', 'search', 'query', 'i18n', 'translation', 'message', 'label', 'config', 'setting', 'settings', 'registry', 'cluster', 'distribution', 'blob', 'asset', 'upload', 'video', 'audio', 'media', 'attachment', 'thumb', 'preview', 'path', 'prefix', 'event', 'join', 'sequence', 'product', 'item', 'entity', 'record', 'resource', 'field', 'column', 'table', 'model', 'cursor', 'page', 'request', 'correlation', 'trace', 'react', 'list', 'dict', 'hotkey', 'shortcut', 'keyboard', 'sorting', 'grouping']);

function keyWords(raw) {
  const folded = [...String(raw).normalize('NFKC')].map((c) => CONFUSABLES[c] ?? c).join('');
  return folded
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => TRANSLATE[w] ?? w);
}

/**
 * classifyKey(raw) -> 'password' (any value length counts) | 'token' (8+ characters) | null.
 * Judges a key name only: the value is judged by isSecretValue.
 */
function classifyKey(raw) {
  const w = keyWords(raw);
  if (w.length === 0) return null;
  const last = w[w.length - 1];
  if (w.length > 1 && (NOT_LAST.has(last) || NOT_FIRST.has(w[0]))) return null;
  if (w.includes('authorization') || w.includes('cookie')) return null; // their own families
  if (w.some((x) => PASSWORD_WORDS.has(x) || /(?:password|passwd|passphrase)$/.test(x))) return 'password';
  if (last === 'pass' && w.length > 1) return 'password';
  if (String(raw).startsWith('_auth') && w[0] === 'auth') return 'token'; // .npmrc _auth / _authToken
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    if (x === 'token' || /^(?:auth|access|refresh|bearer|session|api|id|bot|csrf|xsrf)token$/.test(x)) {
      if (i > 0 && NOT_TOKEN_PREFIX.has(w[i - 1])) return null;
      return 'token';
    }
    if (SECRET_WORDS.has(x) || /(?:secret|apikey|secretkey|privatekey|accesskey)$/.test(x)) return 'token';
  }
  if (last === 'key' && w.length > 1 && !NOT_KEY_PREFIX.has(w[w.length - 2])) return 'token';
  return null;
}

// ------------------------------------------------------------------ value judgement

const PLACEHOLDER = /^(?:\*+|x{3,}|\.{3,}|…|-+|_+|\?+|n\/?a|none|null|nil|undefined|empty|true|false|yes|no|on|off|todo|tbd|fixme|changeme|change[-_ ]?me|replace[-_ ]?me|example|sample|dummy|placeholder|redacted|masked|hidden|secret|sensitive|required|optional|your[-_ ][\w-]*|your[A-Z]\w*|[\w-]*[-_ ]here|['"]{2}|[|>][-+0-9]*)$/i;
const TEMPLATE = /^(?:\$\{[^}]*\}|\$\(?[A-Za-z_]\w*\)?|\{\{[\s\S]*\}\}|%[A-Za-z_]\w*%|#\{[^}]*\}|<[^<>]+>)$/;
const TYPE_NAME = /^(?:string|str|number|int|integer|bool|boolean|any|unknown|object|bytes|buffer|secretstr|text|char|varchar)\??$/i;
const ENV_READ = /^(?:process\.env|os\.environ|os\.getenv|import\.meta\.env|System\.getenv|Deno\.env|ENV\[|getenv\b)/;
const LABELS = new Set(['password', 'passord', 'passwort', 'passphrase', 'token', 'secret', 'apikey', 'hemmelighet', 'pin', 'kode', 'passordet', 'motdepasse', 'contraseña', 'contrasena', 'wachtwoord', 'lösenord', 'losenord', 'salasana', 'adgangskode', 'kodeord']);
const STOP = new Set(['is', 'are', 'was', 'be', 'been', 'the', 'an', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'must', 'should', 'not', 'no', 'and', 'or', 'your', 'you', 'this', 'that', 'it', 'its', 'can', 'will', 'see', 'use', 'enter', 'er', 'og', 'på', 'med', 'til', 'som', 'ikke', 'må', 'ha', 'minst', 'du', 'din', 'ditt', 'kan', 'skal', 'være', 'har', 'en', 'et', 'den', 'det', 'av', 'om']);
const PATH_SEGMENT = /^(?:[a-z0-9][a-z0-9._@~-]*|[0-9a-fA-F-]{8,}|[\w.-]*\.[A-Za-z0-9]{1,8}|[A-Z][a-z]+|\{\{[^}]*\}\}|\$\{[^}]*\})$/;

const onlyTags = (v) => v.replace(TAG_RE, '').replace(/[\s"'`\\,;:]/g, '') === '';

/** A sentence (an error text, a label, docs): two or more words, one of them a function word. */
function isProse(v) {
  const words = v.trim().split(/\s+/);
  if (words.length < 2) return false;
  if (words.some((x) => /\p{L}/u.test(x) && /\d/.test(x))) return false;
  const plain = words.map((x) => x.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''));
  return plain.some((x) => x.length >= 2 && STOP.has(x)) && plain.some((x) => x.length >= 3);
}

function isPath(v) {
  if (/^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/]|\\\\)/.test(v)) return true;
  if (!v.includes('/') || /[+=\s]/.test(v)) return false;
  return v.split('/').every((s) => s === '' || PATH_SEGMENT.test(s));
}

/**
 * isSecretValue(value, cls, { quoted, mode, key }) -> boolean. `mode` is the context the value
 * was read in: 'line' (YAML, headers), 'shell' (k=v), 'flow' (inside {} or ()), 'query', 'conn'.
 */
function isSecretValue(raw, cls, ctx = {}) {
  const v = String(raw).trim();
  if (!v || onlyTags(v)) return false;
  if (PLACEHOLDER.test(v) || TEMPLATE.test(v) || TYPE_NAME.test(v) || /^(?:\$\{|\{\{)/.test(v)) return false;
  if (ENV_READ.test(v)) return false;
  if (!ctx.quoted && ctx.mode !== 'conn' && ctx.mode !== 'query') {
    if (/[()[\]<>]/.test(v)) return false; // a call, a generic, an index: code
    if (/^(?:await|new|yield|typeof|function|lambda|async|this|self)\b/.test(v)) return false;
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[;,]?$/.test(v)) return false; // a member path
    if (/^[A-Za-z_$][\w$]*[,;]$/.test(v)) return false; // `key: identifier,` in an object literal
    if (ctx.mode === 'flow' && /^[A-Za-z_$][\w$]*$/.test(v)) return false;
  }
  if (ctx.key && v.toLowerCase() === String(ctx.key).toLowerCase()) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || isPath(v)) return false;
  if (/^[\p{L}\s.:*-]+$/u.test(v) && LABELS.has(v.toLowerCase().replace(/[^\p{L}]/gu, ''))) return false;
  if (isProse(v)) return false;
  if (cls === 'token') {
    if (v.length < 8 || /^\d{1,11}$/.test(v) || /^[a-z]+$/.test(v)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ helpers

/** Replaces named group `g` of every match whose `accept(m)` is true with the tag; counts. */
function replaceGroup(text, re, g, accept, tag, hit) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const span = m.indices?.groups?.[g];
    if (!span || !accept(m)) continue;
    out += text.slice(last, span[0]) + tag;
    last = span[1];
    hit();
  }
  return last === 0 ? text : out + text.slice(last);
}

function wholeMatch(re, validate) {
  return (text, tag, hit) => text.replace(re, (m) => {
    if (validate && !validate(m)) return m;
    hit();
    return tag;
  });
}


/** basic-auth: the base64 must decode to printable text containing a colon (user:password). */
function isBasicCredential(b64) {
  let text;
  try {
    text = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return false;
  }
  return text.includes(':') && !text.includes('\uFFFD') && /^[^\u0000-\u001f\u007f]+$/u.test(text);
}

const looksLikeToken = (v) => /[0-9_\-.~+/=]/.test(v) || /[a-z][A-Z]/.test(v);

function shannon(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / s.length) * Math.log2(k / s.length);
  return h;
}

// ------------------------------------------------------------------ families

function runSecretBlock(text, tag, hit) {
  if (!/:[ \t]*[|>]/.test(text)) return text;
  const HEAD = /^(?<lead>[ \t]*(?:-[ \t]+)?)(?<q>\\*["']?)(?<key>[\p{L}_$][\p{L}\p{N}_.$-]*)\k<q>[ \t]*:[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$/u;
  const lines = text.split(/(?<=\n)/);
  const body = (l) => l.replace(/\r?\n$/, '');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD.exec(body(lines[i]));
    if (!m || !classifyKey(m.groups.key)) { out += lines[i]; continue; }
    const col = m.groups.lead.length;
    let lastLine = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const b = body(lines[k]);
      if (b.trim() === '') continue;
      if (b.match(/^[ \t]*/)[0].length <= col) break;
      lastLine = k;
    }
    if (lastLine < 0) { out += lines[i]; continue; }
    let first = i + 1;
    while (body(lines[first]).trim() === '') first++;
    const content = lines.slice(first, lastLine + 1).map(body).filter((l) => l.trim()).map((l) => l.trim());
    if (!blockIsSecret(content)) { out += lines[i]; continue; }
    const indent = body(lines[first]).match(/^[ \t]*/)[0];
    const eol = lines[lastLine].match(/\r?\n$/)?.[0] ?? '';
    out += lines.slice(i, first).join('') + indent + tag + eol;
    hit();
    i = lastLine;
  }
  return out;
}

function blockIsSecret(lines) {
  if (lines.every(onlyTags)) return false;
  const joined = lines.join(' ');
  if (TEMPLATE.test(joined) || /^(?:\$\{|\{\{)/.test(joined)) return false;
  // Nested structure (YAML mappings, lists, JSON): the key pass judges its keys one by one.
  if (lines.every((l) => /^(?:-[ \t]+)?["']?[\p{L}_$][\p{L}\p{N}_.$/-]*["']?[ \t]*:(?:[ \t]|$)/u.test(l) || /^(?:-[ \t]|[{}[\]#])/.test(l))) return false;
  if (/^(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-|sk-ssh-|-----BEGIN (?:PUBLIC KEY|CERTIFICATE|SSH2 PUBLIC KEY))/.test(lines[0])) return false;
  return !isProse(joined);
}

function runUrlUserinfo(text, tag, hit) {
  return replaceGroup(text, /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/(?<v>[^\s/@"'`<>]+)(?=@)/dgi, 'v', (m) => {
    const u = m.groups.v;
    if (u === tag) return false; // exactly an earlier tag: idempotent
    return /^[^:@]*:/.test(u) || u.length >= 20;
  }, tag, hit);
}

function runAuthHeader(text, tag, hit) {
  let out = text;
  // Authorization / Proxy-Authorization headers, plain or as JSON keys, with or without a scheme.
  out = replaceGroup(out, /(?<![\w-])(?:proxy-)?authorization\\*["']?[ \t]*[:=][ \t]*\\*["']?[ \t]*(?:(?<scheme>bearer|token|bot|basic|ssws|apikey|api-key|key)[ \t]+)?(?<v>[A-Za-z0-9._~+/=-]+)/dgi, 'v', (m) => {
    const { scheme, v } = m.groups;
    if (/^basic$/i.test(scheme ?? '')) return isBasicCredential(v) || /[0-9+/=]/.test(v);
    return v.length >= 8 && looksLikeToken(v);
  }, tag, hit);
  // Digest: only the response hash is a credential.
  out = replaceGroup(out, /(?<![\w-])authorization\\*["']?[ \t]*:[ \t]*\\*["']?[ \t]*digest\b[^\r\n]{0,1024}?\bresponse=\\*"(?<v>[^"\\\r\n]+)/dgi, 'v', () => true, tag, hit);
  // A bare "Bearer <token>" or "Basic <base64 of user:pw>" outside a header.
  out = replaceGroup(out, /(?<![\w-])bearer[ \t]+(?<v>[A-Za-z0-9._~+/-]{8,}=*)(?![A-Za-z0-9._~+/=-])/dgi, 'v', (m) => looksLikeToken(m.groups.v), tag, hit);
  out = replaceGroup(out, /(?<![\w-])Basic[ \t]+(?<v>[A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/dg, 'v', (m) => isBasicCredential(m.groups.v), tag, hit);
  return out;
}

function runCookie(text, tag, hit) {
  return text.replace(/(?<![\w-])(set-cookie|cookie)([ \t]*:[ \t]*)([^\r\n]*)/gi, (all, name, sep, rest) => {
    const pairs = rest.split(/(;[ \t]*)/);
    const limit = /^set-/i.test(name) ? 1 : Infinity;
    let seen = 0;
    const done = pairs.map((p, i) => {
      if (i % 2 === 1 || seen >= limit) return p;
      const m = /^([^=\s;]+=)(.*)$/.exec(p);
      if (!m) return p;
      seen += 1;
      const v = m[2].trim();
      if (v.length < 8 || onlyTags(v) || TEMPLATE.test(v)) return p;
      hit();
      return m[1] + tag;
    });
    return name + sep + done.join('');
  });
}

function runCliSecret(text, tag, hit) {
  let out = text;
  out = replaceGroup(out, /(?<![\w-])--(?<flag>[A-Za-z][\w-]*)(?:=|[ \t]+)(?!-)(?<v>\\*"[^"\r\n]*\\*"|'[^'\r\n]*'|[^\s"'`|&;<>]+)/dg, 'v', (m) => {
    const cls = classifyKey(m.groups.flag);
    const v = m.groups.v.replace(/^\\*["']|\\*["']$/g, '');
    return Boolean(cls) && isSecretValue(v, 'password', { quoted: true });
  }, tag, hit);
  out = replaceGroup(out, /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump|mysqlsh)\b[^\r\n]{0,1024}?[ \t]-p(?<v>[^\s"'[]+)/dg, 'v', () => true, tag, hit);
  out = replaceGroup(out, /\b(?:login\b[^\r\n]{0,1024}?[ \t]-p|sshpass[ \t]+-p)[ \t]*(?<v>[^\s"'[-][^\s"']*)/dg, 'v', () => true, tag, hit);
  out = replaceGroup(out, /\bcurl\b[^\r\n]{0,1024}?[ \t](?:-u|--user)[ =]+["']?[^\s:"']+:(?<v>[^\s"'[]+)/dg, 'v', () => true, tag, hit);
  return out;
}

// One regex finds candidate keys; the scanner below reads the value the way its context writes it.
const KEY_RE = /(?<![\p{L}\p{N}_$.\\-])(?<q>(?:\\*["'])?)(?<key>[\p{L}_$][\p{L}\p{N}_.$-]*)\k<q>(?<pre>[ \t]*)(?<sep>:(?!:)|=(?![=>~]))/gu;
const VOUCHING_WORDS = new Set(['token', 'key', 'id', 'ids', 'cursor', 'hash', 'digest', 'integrity', 'checksum', 'etag', 'sha', 'nonce', 'sid', 'uid', 'uuid', 'ref', 'revision', 'commit']);
const KEYWORD_BEFORE =/(?:^|\s)(?:export|set|setx|const|let|var|val|local|my|readonly|declare|private|public|protected|static|final)[ \t]+$/;

const WINDOW = 16384; // the longest value the key pass reads; it keeps a huge one-line text linear

function findClose(text, from, quote, to) {
  const n = quote.length - 1;
  const ch = quote[n];
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === '\n' || c === '\r') return -1;
    if (c !== ch) continue;
    let b = 0;
    for (let k = i - 1; k >= from && text[k] === '\\'; k--) b++;
    if (n === 0 ? b % 2 === 0 : b === n) return i - n;
  }
  return -1;
}

function runKeyed(text, tag, hit, ctx) {
  let out = '';
  let last = 0;
  // Matches only move forward, so the current line is tracked, never searched for again.
  let lineStart = 0;
  let nextNl = text.indexOf('\n');
  const lineOf = (i) => {
    while (nextNl !== -1 && nextNl < i) {
      lineStart = nextNl + 1;
      nextNl = text.indexOf('\n', lineStart);
    }
    let end = nextNl === -1 ? text.length : nextNl;
    if (text[end - 1] === '\r') end -= 1;
    return { start: lineStart, end };
  };
  const SPACES = /[ \t]*/y;
  KEY_RE.lastIndex = 0;
  let m;
  while ((m = KEY_RE.exec(text))) {
    const { q, key, pre, sep } = m.groups;
    const afterSep = m.index + m[0].length;
    if (!q && sep === ':' && afterSep < text.length && !/[\s"'\\]/.test(text[afterSep])) continue;
    const line = lineOf(m.index);
    const from = Math.max(line.start, m.index - 256);
    const before = text.slice(from, m.index);
    const t = before.trimEnd();
    const c = t.slice(-1);
    const atLineStart = t === '' && from === line.start;
    const spaceAfter = text[afterSep] === ' ' || text[afterSep] === '\t';
    const eqTight = sep === '=' && !pre && !spaceAfter;
    SPACES.lastIndex = afterSep;
    const vStart = afterSep + SPACES.exec(text)[0].length;
    const restEnd = Math.min(line.end, vStart + WINDOW);
    const rest = text.slice(vStart, restEnd);
    const lineText = text.slice(Math.max(line.start, m.index - 2048), Math.min(line.end, vStart + 2048));
    let mode = 'line';
    if (c === '?' || c === '&') mode = 'query';
    else if (c === ';' && sep === '=') mode = 'conn';
    else if (c && '{,(['.includes(c)) mode = 'flow';
    else if (eqTight) mode = /;[ \t]*[\p{L}][\p{L}\p{N} _.-]*=/u.test(lineText) ? 'conn' : 'shell';

    // The value: quoted (at the key's escape depth or any other), or read to the end of its context.
    let vFrom = vStart;
    let vTo;
    let quoted = false;
    const qv = /^\\*["']/.exec(rest)?.[0];
    if (qv) {
      const close = findClose(text, vStart + qv.length, qv, restEnd);
      if (close >= 0) {
        vFrom = vStart + qv.length;
        vTo = close;
        quoted = true;
      }
    }
    if (!quoted) {
      let raw;
      // A tag an earlier pass wrote is one atom, so its closing bracket never ends the value.
      if (mode === 'query') raw = rest.match(/^(?:\[REDACTED:[a-z-]+\]|[^&#\s"'<>)\]])*/)[0];
      else if (mode === 'conn') raw = rest.startsWith('{') && rest.includes('}') ? rest.slice(0, rest.indexOf('}') + 1) : rest.match(/^[^;"']*/)[0].trimEnd();
      else if (mode === 'flow') raw = rest.match(/^(?:\[REDACTED:[a-z-]+\]|[^,;})\]])*/)[0].trimEnd();
      else if (mode === 'shell') raw = rest.match(/^(?:\[REDACTED:[a-z-]+\]|[^\s;&,"'<>)\]`|])*/)[0];
      else raw = rest.replace(/[ \t]+(?:#|\/\/).*$/, '').trimEnd();
      vTo = vStart + raw.length;
    }
    const value = text.slice(vFrom, vTo);
    const cls = classifyKey(key);
    const positioned = atLineStart || eqTight || '{,;&?([:|-*>#/'.includes(c) || KEYWORD_BEFORE.test(before);
    if (cls && positioned && isSecretValue(value, cls, { quoted, mode, key })) {
      out += text.slice(last, vFrom) + tag;
      last = vTo;
      KEY_RE.lastIndex = Math.max(vTo, afterSep);
      hit();
    } else if (value.trim() && keyWords(key).some((w) => VOUCHING_WORDS.has(w))) {
      ctx.keep.add(value.trim()); // an id-like key (page_token, cache_key, request_id) vouches for its value
    }
  }
  return out + text.slice(last);
}

function runEntropy(text, tag, hit, ctx) {
  return text.replace(/(?<![A-Za-z0-9+/=_.-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g, (tok, at) => {
    const core = tok.replace(/=+$/, '');
    if (!/[A-Z]/.test(core) || !/[a-z]/.test(core) || !/[0-9]/.test(core)) return tok;
    if (/^[0-9a-f-]+$/i.test(core) || /^AAAA/.test(core) || /^sha\d+-/.test(core)) return tok;
    if (ctx.keep.has(tok)) return tok;
    if (/(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+)[ \t]+$/.test(text.slice(Math.max(0, at - 40), at))) return tok;
    const letters = core.replace(/[^A-Za-z]/g, '');
    const vowels = letters.replace(/[^aeiouAEIOU]/g, '').length / Math.max(1, letters.length);
    if (vowels >= 0.3 || shannon(core) < 4.2) return tok;
    hit();
    return tag;
  });
}

/** @type {ReadonlyArray<{name: string, reason: string, run: (text: string, tag: string, hit: () => void, ctx: {keep: Set<string>}) => string}>} */
export const FAMILIES = Object.freeze([
  { name: 'pem-private-key', reason: 'a private key block (PEM or PGP) is a credential in full; the whole block goes, to the end of the text when its END line is missing', run: wholeMatch(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$(?![\s\S]))/g) },
  { name: 'secret-block', reason: 'a YAML block or folded scalar (| or >) under a secret key carries the value on the indented lines below it; nested structure, templates, public keys and prose stay', run: runSecretBlock },
  { name: 'url-userinfo', reason: 'DSNs and URLs carry passwords (user:pw@) or tokens (long-token@) in the userinfo part; a bare short user name such as git@ is not a secret', run: runUrlUserinfo },
  { name: 'auth-header', reason: 'an Authorization value (Bearer, Token, Basic, a Digest response) is a live credential; prose such as "uses Bearer authentication" is not', run: runAuthHeader },
  { name: 'cookie', reason: 'Cookie and Set-Cookie values are session credentials; Set-Cookie attributes and short preference values stay', run: runCookie },
  { name: 'cli-secret', reason: 'a password or token on a command line: --password x, --token=x, mysql -p<pw>, docker login -p x, curl -u user:pw', run: runCliSecret },
  { name: 'wybe-credential', reason: 'wnc_/wbt_/wpc_/wat_/wrt_/wac_/wcl_ are Wybe credentials with different lifetimes but the same blast radius when leaked', run: wholeMatch(new RegExp(`${B}w(?:nc|bt|pc|at|rt|ac|cl)_[A-Za-z0-9_-]{16,}${E}`, 'g')) },
  { name: 'openai-key', reason: 'sk-... keys (OpenAI style, and sk-ant-... for Anthropic) grant paid API access', run: wholeMatch(new RegExp(`${B}sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}${E}`, 'g')) },
  { name: 'aws-access-key', reason: 'AKIA... (long-lived) and ASIA... (temporary) are AWS access key ids', run: wholeMatch(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g) },
  { name: 'github-token', reason: 'ghp_/gho_/ghu_/ghs_/ghr_ and github_pat_ tokens act as the person on GitHub', run: wholeMatch(/\b(?:gh[opusr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g) },
  { name: 'gitlab-token', reason: 'glpat-... is a GitLab personal access token', run: wholeMatch(new RegExp(`${B}glpat-[A-Za-z0-9_-]{20,}${E}`, 'g')) },
  { name: 'npm-token', reason: 'an npm access token (npm_ and 36 characters) publishes packages as the person', run: wholeMatch(/\bnpm_[A-Za-z0-9]{36}\b/g) },
  { name: 'slack-token', reason: 'xox[abpors]-... are Slack bot/user tokens and xapp-... app-level tokens', run: wholeMatch(/\b(?:xox[abpors]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})/g) },
  { name: 'slack-webhook', reason: 'a Slack incoming-webhook URL lets anyone post to that channel', run: (text, tag, hit) => replaceGroup(text, /\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows)\/(?<v>[A-Za-z0-9/_-]{20,})/dg, 'v', () => true, tag, hit) },
  { name: 'stripe-key', reason: 'sk_live_/sk_test_/rk_ keys move money and whsec_ signs Stripe webhooks', run: wholeMatch(new RegExp(`${B}(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,})${E}`, 'g')) },
  { name: 'google-api-key', reason: 'AIza... is a Google API key and GOCSPX-... a Google OAuth client secret', run: wholeMatch(new RegExp(`${B}(?:AIza[0-9A-Za-z_-]{30,40}|GOCSPX-[A-Za-z0-9_-]{20,})${E}`, 'g')) },
  { name: 'sendgrid-key', reason: 'SG.<id>.<secret> is a SendGrid API key', run: wholeMatch(new RegExp(`${B}SG\\.[A-Za-z0-9_-]{16,32}\\.[A-Za-z0-9_-]{30,50}${E}`, 'g')) },
  { name: 'twilio-key', reason: 'SK and 32 hex characters is a Twilio API key sid that pairs with its secret', run: wholeMatch(/\bSK[0-9a-f]{32}\b/g) },
  { name: 'discord-token', reason: 'a Discord bot token is a base64 user id, a 6-character timestamp and an HMAC, dot-separated', run: wholeMatch(new RegExp(`${B}[MNO][A-Za-z0-9_-]{23,27}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,40}${E}`, 'g')) },
  { name: 'microsoft-token', reason: 'a Microsoft identity refresh token starts 0.A and runs on for hundreds of characters', run: wholeMatch(/(?<![A-Za-z0-9._-])0\.A[A-Za-z0-9_-]{20,}[A-Za-z0-9._-]*/g) },
  { name: 'jwt', reason: 'three dot-separated base64url parts starting with eyJ is a signed bearer token', run: wholeMatch(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g) },
  { name: 'keyed-secret', reason: 'a value under a secret key (password, secret, token, <x>_key, in any language or escape depth) unless it is a placeholder, type, code, path, label or sentence', run: runKeyed },
  { name: 'high-entropy', reason: 'a 40+ character random string (mixed case and digits, few vowels, high entropy) that no key vouched for is treated as a credential', run: runEntropy },
  { name: 'fodselsnummer', reason: 'a Norwegian fodselsnummer identifies one person for life; only numbers whose two control digits verify are redacted', run: wholeMatch(/(?<!\d)\d{6}\s?\d{5}(?!\d)/g, (m) => isValidFodselsnummer(m)) },
  { name: 'email', reason: 'an e-mail address identifies a person (configurable: {emails: false} keeps them); the user@host of a URL such as ssh://git@github.com is not one', run: wholeMatch(/(?<![\w.%+-]|:\/\/)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b(?!:[^\s])/g) },
]);

const FAMILY_NAMES = new Set(FAMILIES.map((f) => f.name));

/**
 * Mod-11 control digits of a Norwegian fodselsnummer (11 digits, d1..d9 + k1 k2), as in
 * wybe-node's packages/integrations/src/privacy.ts.
 * k1 = 11 - ((3d1+7d2+6d3+1d4+8d5+9d6+4d7+5d8+2d9) mod 11), k2 = 11 - ((5d1+4d2+3d3+2d4+7d5+6d6+5d7+4d8+3d9+2k1) mod 11).
 * A result of 11 means 0; a result of 10 means the number cannot exist.
 */
export function isValidFodselsnummer(candidate) {
  const digits = String(candidate).replace(/\s/g, '');
  if (!/^\d{11}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  const w1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
  const w2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let k1 = 11 - (w1.reduce((s, w, i) => s + w * d[i], 0) % 11);
  if (k1 === 11) k1 = 0;
  if (k1 === 10 || k1 !== d[9]) return false;
  let k2 = 11 - (w2.reduce((s, w, i) => s + w * (i < 9 ? d[i] : k1), 0) % 11);
  if (k2 === 11) k2 = 0;
  if (k2 === 10 || k2 !== d[10]) return false;
  return true;
}

function activeFamilies(options) {
  const disable = new Set(options.disable ?? []);
  for (const name of disable) {
    if (!FAMILY_NAMES.has(name)) throw new Error(`redact: unknown family in options.disable: ${name}`);
  }
  if (options.emails === false) disable.add('email');
  return FAMILIES.filter((f) => !disable.has(f.name));
}

/**
 * redact(text, options) -> { text, hits: [{ family, count }] }
 * options.emails  (default true)   false keeps e-mail addresses
 * options.disable (default [])     family names to switch off (a positive control uses this; production never does)
 */
export function redact(text, options = {}) {
  return runFamilies(text, options, new Set());
}

/** `keep`: values an id-like key already vouched for (the entropy check leaves them alone). */
function runFamilies(text, options, keep) {
  if (typeof text !== 'string') throw new TypeError('redact: text must be a string');
  const hits = [];
  const ctx = { keep };
  let out = text;
  for (const family of activeFamilies(options)) {
    let count = 0;
    out = family.run(out, `[REDACTED:${family.name}]`, () => { count += 1; }, ctx);
    if (count > 0) hits.push({ family: family.name, count });
  }
  return { text: out, hits };
}

/**
 * Walks a JSON-shaped value and redacts every string in it; a string under a secret object key
 * (password, api_key, ...) is judged by that key as well. Numbers, booleans and null pass
 * through; anything else (functions, symbols, undefined, class instances) is refused, because a
 * payload that carries something this walker does not understand must not leave the machine.
 */
export function redactValue(value, options = {}) {
  const totals = new Map();
  const add = (family, n) => totals.set(family, (totals.get(family) ?? 0) + n);
  const byKey = activeFamilies(options).some((f) => f.name === 'keyed-secret');
  const walk = (v, path, key) => {
    if (typeof v === 'string') {
      const vouched = key !== undefined && !classifyKey(key) && keyWords(key).some((w) => VOUCHING_WORDS.has(w));
      const r = runFamilies(v, options, new Set(vouched ? [v.trim()] : []));
      for (const h of r.hits) add(h.family, h.count);
      return r.text;
    }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`));
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out = {};
      for (const [k, item] of Object.entries(v)) {
        const cls = byKey && typeof item === 'string' ? classifyKey(k) : null;
        if (cls && isSecretValue(item, cls, { quoted: true, key: k })) {
          add('keyed-secret', 1);
          out[k] = '[REDACTED:keyed-secret]';
        } else {
          out[k] = walk(item, `${path}.${k}`, k);
        }
      }
      return out;
    }
    throw new TypeError(`redactValue: unsupported value at ${path} (${typeof v})`);
  };
  const out = walk(value, '$');
  const hits = FAMILIES.filter((f) => totals.has(f.name)).map((f) => ({ family: f.name, count: totals.get(f.name) }));
  return { value: out, hits };
}
