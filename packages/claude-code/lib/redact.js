// Laptop-side redaction. Pattern-based, deterministic, no LLM (an LLM can itself leak).
// Every string that leaves the machine passes through redact() first. The original text is
// never logged, never stored, never returned alongside the redacted one.
//
// Shapes for the Norwegian identifiers are ported from wybe-node's
// packages/integrations/src/privacy.ts (Wybe Labs AS, same licence family); this repository
// has no dependencies, so they are copied with attribution rather than imported.
//
// Each family is ONE line below so that test/redact-weaken.js can weaken exactly one at a time.
// Order matters: block-shaped families (PEM) run before token-shaped ones so a key body is
// never half-eaten by a narrower pattern. `keep` is a named group whose text survives the
// replacement (the label before a secret), everything else in the match becomes the tag.

const B = '(?<![A-Za-z0-9_-])'; // left boundary that also refuses to start inside a longer token
const E = '(?![A-Za-z0-9_-])'; // right boundary tolerant of trailing base64url characters

/** @type {ReadonlyArray<{name: string, reason: string, re: RegExp, validate?: (m: string) => boolean}>} */
export const FAMILIES = Object.freeze([
  { name: 'pem-private-key', reason: 'a private key block is a credential in full, whole block goes', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'url-userinfo', reason: 'DSNs and URLs carry passwords in the userinfo part (postgres://user:pw@host)', re: /(?<keep>\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"'`<>]+(?=@)/gi },
  { name: 'bearer', reason: 'an Authorization: Bearer value is a live access token', re: /(?<keep>\bBearer\s+)[A-Za-z0-9_\-.~+/=]{8,}/gi },
  { name: 'wybe-credential', reason: 'wnc_/wbt_/wpc_/wat_/wrt_/wac_/wcl_ are Wybe credentials with different lifetimes but the same blast radius when leaked', re: new RegExp(`${B}w(?:nc|bt|pc|at|rt|ac|cl)_[A-Za-z0-9_-]{16,}${E}`, 'g') },
  { name: 'openai-key', reason: 'sk-... keys (OpenAI style, and sk-ant-... for Anthropic) grant paid API access', re: new RegExp(`${B}sk-(?:ant-)?[A-Za-z0-9_-]{20,}${E}`, 'g') },
  { name: 'aws-access-key', reason: 'AKIA... is an AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'aws-secret', reason: 'a 40-character secret after an aws secret label is the matching AWS secret key', re: /(?<keep>\baws[_-]?secret(?:[_-]?access)?[_-]?key\b\s*["']?\s*[:=]\s*["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi },
  { name: 'github-token', reason: 'ghp_/gho_/ghu_/ghs_/ghr_ and github_pat_ tokens act as the person on GitHub', re: /\b(?:gh[opusr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { name: 'slack-token', reason: 'xox[abpors]-... are Slack bot/user/app tokens', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}/g },
  { name: 'jwt', reason: 'three dot-separated base64url parts starting with eyJ is a signed bearer token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_.-])/g },
  { name: 'generic-secret', reason: 'a 32+ character hex or base64url value after a token/secret/key/password label is a credential whatever its vendor', re: /(?<keep>\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|key)\b["']?\s*[:=]\s*["']?)(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{32,})(?![A-Za-z0-9_-])/gi },
  { name: 'fodselsnummer', reason: 'a Norwegian fodselsnummer identifies one person for life; only numbers whose two control digits verify are redacted', re: /(?<!\d)\d{6}\s?\d{5}(?!\d)/g, validate: isValidFodselsnummer },
  { name: 'email', reason: 'an e-mail address identifies a person (configurable: {emails: false} keeps them)', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
]);

const FAMILY_NAMES = new Set(FAMILIES.map((f) => f.name));

/**
 * Mod-11 control digits of a Norwegian fodselsnummer (11 digits, d1..d9 + k1 k2).
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
  if (typeof text !== 'string') throw new TypeError('redact: text must be a string');
  const hits = [];
  let out = text;
  for (const family of activeFamilies(options)) {
    let count = 0;
    const tag = `[REDACTED:${family.name}]`;
    out = out.replace(family.re, (...args) => {
      const match = args[0];
      const groups = typeof args[args.length - 1] === 'object' ? args[args.length - 1] : undefined;
      if (family.validate && !family.validate(match)) return match;
      count += 1;
      return (groups?.keep ?? '') + tag;
    });
    if (count > 0) hits.push({ family: family.name, count });
  }
  return { text: out, hits };
}

/**
 * Walks a JSON-shaped value and redacts every string in it. Numbers, booleans and null pass
 * through; anything else (functions, symbols, undefined, class instances) is refused, because a
 * payload that carries something this walker does not understand must not leave the machine.
 */
export function redactValue(value, options = {}) {
  const totals = new Map();
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const r = redact(v, options);
      for (const h of r.hits) totals.set(h.family, (totals.get(h.family) ?? 0) + h.count);
      return r.text;
    }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`));
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out = {};
      for (const [k, item] of Object.entries(v)) out[k] = walk(item, `${path}.${k}`);
      return out;
    }
    throw new TypeError(`redactValue: unsupported value at ${path} (${typeof v})`);
  };
  const out = walk(value, '$');
  const hits = FAMILIES.filter((f) => totals.has(f.name)).map((f) => ({ family: f.name, count: totals.get(f.name) }));
  return { value: out, hits };
}
