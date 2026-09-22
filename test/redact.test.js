import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactValue, FAMILIES, isValidFodselsnummer } from '../lib/redact.js';

// Every bait below is SYNTHETIC. Shapes are real (a real DSN layout, a real wnc_ layout, a real
// PEM frame, a real sk-ant- layout); the values are invented and open nowhere. They are assembled
// from fragments at runtime so that no secret-shaped literal ever sits in this repository (the
// secrets guard that scans commits would otherwise refuse the file, and it is right to). The
// redactor sees the full, realistic string.

const j = (...parts) => parts.join('');

const BAIT = {
  dsn: j('postgres://atlas_core:', 'Xk9$uT2vQ7pLm4wE', '@db.internal.wybe.me:5432/atlas?sslmode=require'),
  dsnPassword: 'Xk9$uT2vQ7pLm4wE',
  wnc: j('wnc_', 'VsYdQqyC9NxtJ_eyZJpii9BjLY4BkQChOnK--fxRADk'),
  wbt: j('wbt_', 'Q1v8Lr3kZpT0aYbN5cWx7eHs2jUo9mDiFgKh4tRq'),
  watBody: 'p0Oi9Uy8Tr7Ew6Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm',
  skAnt: j('sk-ant-', 'api03-', 'Ab3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY1zA3bC5dE7f-Ab3dE5AA'),
  sk: j('sk-', 'proj-', 'Zx9Cv8Bn7Mm6Aa5Ss4Dd3Ff2Gg1Hh0Jj9Kk8Ll7Qq6Ww5Ee4Rr3Tt2Yy1Uu0Ii'),
  akia: j('AKIA', 'IOSFODNN7EXAMPLE'),
  awsSecret: j('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY'),
  ghp: j('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubPat: j('github_', 'pat_', '11ABCDEFG0abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345'),
  slack: j('xoxb-', '1234567890123-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'),
  jwt: j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),
  jwtSignature: 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  hexValue: j('9f86d081884c7d659a2feaa0c55ad015', 'a3bf4f1b2b0b822cd15d6c15b0f00a08'),
  pemHeader: j('-----BEGIN ', 'RSA PRIVATE KEY-----'),
  pemFooter: j('-----END ', 'RSA PRIVATE KEY-----'),
  pemBody: 'MIIEowIBAAKCAQEAyVxq7Yl8aXk0Yk2n3bGx0Q3e0lJtq7d1XvXk9H3v9r0bZ4u6\nw7lQ2Yd3sVh3p1b0Qx3f9J1q8bH2Zr0m5Yn4Lc7pT9Xu2Ka1sS8dF6gH4jK2lM0nO',
  fnrValid: '15058545640',
  fnrInvalid: '15058545641',
  elevenDigitsNotFnr: '12345678901',
  email: 'kari.nordmann@example.no',
};
BAIT.wat = j('wat_', BAIT.watBody);
BAIT.bearer = j('Authorization: Bearer ', BAIT.wat);
BAIT.hexSecret = j('client_', 'secret=', BAIT.hexValue);
BAIT.pem = [BAIT.pemHeader, BAIT.pemBody, BAIT.pemFooter].join('\n');

function tag(family) {
  return `[REDACTED:${family}]`;
}

test('a Postgres DSN loses its userinfo, keeps scheme and host', () => {
  const r = redact(`DATABASE_URL=${BAIT.dsn}`);
  assert.ok(!r.text.includes(BAIT.dsnPassword), 'password leaked');
  assert.ok(!r.text.includes('atlas_core:'), 'username leaked');
  assert.equal(r.text, `DATABASE_URL=postgres://${tag('url-userinfo')}@db.internal.wybe.me:5432/atlas?sslmode=require`);
  assert.deepEqual(r.hits, [{ family: 'url-userinfo', count: 1 }]);
});

test('any scheme://user:pass@ is caught, not only postgres', () => {
  const r = redact(j('curl https://deploy:', 's3cr3t-pw', '@registry.example.com/v2/ and redis://:', 'hunter2', '@cache:6379'));
  assert.ok(!r.text.includes('s3cr3t-pw'));
  assert.ok(!r.text.includes('hunter2'));
  assert.deepEqual(r.hits, [{ family: 'url-userinfo', count: 2 }]);
});

test('a URL without userinfo is untouched', () => {
  const r = redact('see https://docs.wybe.me/connect and http://127.0.0.1:8081/health');
  assert.deepEqual(r.hits, []);
});

test('a wnc_ node credential with 43 base64url characters is redacted', () => {
  const r = redact(`node credential: ${BAIT.wnc}`);
  assert.ok(!r.text.includes(BAIT.wnc));
  assert.ok(!r.text.includes(BAIT.wnc.slice(4)), 'the body after the prefix leaked');
  assert.equal(r.text, `node credential: ${tag('wybe-credential')}`);
  assert.deepEqual(r.hits, [{ family: 'wybe-credential', count: 1 }]);
});

test('every Wybe prefix is covered: wnc_ wbt_ wpc_ wat_ wrt_ wac_ wcl_', () => {
  const body = BAIT.wnc.slice(4);
  for (const p of ['wnc', 'wbt', 'wpc', 'wat', 'wrt', 'wac', 'wcl']) {
    const r = redact(`${p}_${body}`);
    assert.equal(r.text, tag('wybe-credential'), `${p}_ leaked`);
  }
});

test('a short wnc_-looking word is not a credential', () => {
  const r = redact('the wnc_ prefix and wbt_x are just words here');
  assert.deepEqual(r.hits, []);
});

test('sk-ant-api03-... and sk-proj-... keys are redacted in full', () => {
  const r = redact(`ANTHROPIC_API_KEY=${BAIT.skAnt}\nOPENAI_API_KEY=${BAIT.sk}`);
  assert.ok(!r.text.includes(BAIT.skAnt));
  assert.ok(!r.text.includes(BAIT.sk));
  assert.ok(!r.text.includes('api03-Ab3dE5fG7hI9'), 'key body leaked');
  assert.deepEqual(r.hits, [{ family: 'openai-key', count: 2 }]);
});

test('AWS access key id and the secret after its label are redacted', () => {
  const r = redact(`aws_access_key_id = ${BAIT.akia}\naws_secret_access_key = ${BAIT.awsSecret}`);
  assert.ok(!r.text.includes(BAIT.akia));
  assert.ok(!r.text.includes(BAIT.awsSecret));
  assert.equal(r.text, `aws_access_key_id = ${tag('aws-access-key')}\naws_secret_access_key = ${tag('aws-secret')}`);
  assert.deepEqual(r.hits, [{ family: 'aws-access-key', count: 1 }, { family: 'aws-secret', count: 1 }]);
});

test('GitHub ghp_ and github_pat_ tokens are redacted', () => {
  const r = redact(`git remote set-url origin https://x-access-token:${BAIT.ghp}@github.com/wybe-labs/x.git\nGH_TOKEN=${BAIT.githubPat}`);
  assert.ok(!r.text.includes(BAIT.ghp));
  assert.ok(!r.text.includes(BAIT.githubPat));
  assert.equal(redact(BAIT.ghp).text, tag('github-token'));
  assert.equal(redact(BAIT.githubPat).text, tag('github-token'));
});

test('Slack xox tokens are redacted', () => {
  const r = redact(`SLACK_BOT_TOKEN=${BAIT.slack}`);
  assert.equal(r.text, `SLACK_BOT_TOKEN=${tag('slack-token')}`);
  assert.deepEqual(r.hits, [{ family: 'slack-token', count: 1 }]);
});

test('a JWT is redacted as one unit', () => {
  const r = redact(`session=${BAIT.jwt};`);
  assert.equal(r.text, `session=${tag('jwt')};`);
  assert.ok(!r.text.includes(BAIT.jwtSignature), 'signature leaked');
});

test('an Authorization: Bearer header keeps the label and loses the value', () => {
  const r = redact(BAIT.bearer);
  assert.equal(r.text, `Authorization: Bearer ${tag('bearer')}`);
  assert.ok(!r.text.includes(BAIT.watBody));
  assert.deepEqual(r.hits, [{ family: 'bearer', count: 1 }]);
});

test('a 64-hex secret after client_secret= is redacted; the same hex without a label is not', () => {
  const r = redact(BAIT.hexSecret);
  assert.equal(r.text, `client_secret=${tag('generic-secret')}`);
  assert.deepEqual(r.hits, [{ family: 'generic-secret', count: 1 }]);
  const bare = redact(`git sha ${BAIT.hexValue}`);
  assert.deepEqual(bare.hits, [], 'a bare hash (git sha, content hash) must survive');
});

test('generic-secret also covers JSON style ("token": "...") and password= with base64url', () => {
  const t = BAIT.wnc.slice(4);
  const p = j('Qa5Sd4Fg3Hj2Kl1Zx0Cv9Bn8Mm', 'P0oI9uY8tR7eW6q');
  const r = redact(`{"token": "${t}", "password":"${p}"}`);
  assert.ok(!r.text.includes(t));
  assert.ok(!r.text.includes(p));
  assert.deepEqual(r.hits, [{ family: 'generic-secret', count: 2 }]);
});

test('a PEM private key block is removed whole, header to footer', () => {
  const text = `here is the key:\n${BAIT.pem}\nend.`;
  const r = redact(text);
  assert.equal(r.text, `here is the key:\n${tag('pem-private-key')}\nend.`);
  assert.ok(!r.text.includes('MIIEowIBAAKCAQEA'));
  assert.ok(!r.text.includes(BAIT.pemHeader));
  assert.deepEqual(r.hits, [{ family: 'pem-private-key', count: 1 }]);
});

test('fodselsnummer control digits: a valid synthetic number verifies, a one-digit change does not', () => {
  assert.equal(isValidFodselsnummer(BAIT.fnrValid), true);
  assert.equal(isValidFodselsnummer(BAIT.fnrInvalid), false);
  assert.equal(isValidFodselsnummer(BAIT.elevenDigitsNotFnr), false);
  assert.equal(isValidFodselsnummer('150585 45640'), true, 'a space after the birth date is allowed');
  assert.equal(isValidFodselsnummer('1505854564'), false, 'ten digits is not a fodselsnummer');
});

test('a valid fodselsnummer is redacted; an ordinary 11-digit number is not', () => {
  const r = redact(`fnr ${BAIT.fnrValid}, order ${BAIT.elevenDigitsNotFnr}, spaced 150585 45640, wrong ${BAIT.fnrInvalid}`);
  assert.ok(!r.text.includes(BAIT.fnrValid));
  assert.ok(!r.text.includes('150585 45640'));
  assert.ok(r.text.includes(BAIT.elevenDigitsNotFnr), 'an ordinary 11-digit number must survive');
  assert.ok(r.text.includes(BAIT.fnrInvalid), 'a number whose control digits fail must survive');
  assert.deepEqual(r.hits, [{ family: 'fodselsnummer', count: 2 }]);
});

test('e-mail addresses are redacted by default and kept with {emails: false}', () => {
  const r = redact(`write to ${BAIT.email}`);
  assert.equal(r.text, `write to ${tag('email')}`);
  assert.deepEqual(r.hits, [{ family: 'email', count: 1 }]);
  const kept = redact(`write to ${BAIT.email}`, { emails: false });
  assert.equal(kept.text, `write to ${BAIT.email}`);
  assert.deepEqual(kept.hits, []);
});

test('POSITIVE CONTROL: disabling url-userinfo (and email, which catches the tail of a password as an address) lets the DSN password leak', () => {
  const r = redact(`DATABASE_URL=${BAIT.dsn}`, { disable: ['url-userinfo', 'email'] });
  assert.ok(r.text.includes(BAIT.dsnPassword), 'the control did not leak, so the passing tests above prove nothing');
  assert.ok(!r.hits.some((h) => h.family === 'url-userinfo'));
});

test('POSITIVE CONTROL: disabling wybe-credential lets the wnc_ credential leak', () => {
  const r = redact(`node credential: ${BAIT.wnc}`, { disable: ['wybe-credential'] });
  assert.ok(r.text.includes(BAIT.wnc), 'the control did not leak');
});

test('an unknown family name in options.disable throws instead of silently protecting nothing', () => {
  assert.throws(() => redact('x', { disable: ['not-a-family'] }), /unknown family/);
});

test('hits are reported in family order and only for families that matched', () => {
  const r = redact(`${BAIT.email} ${BAIT.wnc} ${BAIT.dsn}`);
  assert.deepEqual(
    r.hits.map((h) => h.family),
    ['url-userinfo', 'wybe-credential', 'email'],
  );
});

test('a text with nothing to redact comes back identical', () => {
  const text = 'Refactored the ingest queue; 3 files touched; ran bun test apps/ingest (42 pass).';
  const r = redact(text);
  assert.equal(r.text, text);
  assert.deepEqual(r.hits, []);
});

test('redact refuses non-strings', () => {
  assert.throws(() => redact(null), TypeError);
  assert.throws(() => redact(42), TypeError);
});

test('redactValue walks nested payloads and totals hits per family', () => {
  const r = redactValue({
    prompts: [{ text: `use ${BAIT.wnc}` }, { text: `and ${BAIT.wbt}` }],
    meta: { n: 2, ok: true, none: null, dsn: BAIT.dsn },
  });
  assert.equal(r.value.prompts[0].text, `use ${tag('wybe-credential')}`);
  assert.equal(r.value.prompts[1].text, `and ${tag('wybe-credential')}`);
  assert.ok(!r.value.meta.dsn.includes(BAIT.dsnPassword));
  assert.deepEqual(r.value.meta.n, 2);
  assert.deepEqual(r.hits, [{ family: 'url-userinfo', count: 1 }, { family: 'wybe-credential', count: 2 }]);
});

test('redactValue throws on a value it does not understand rather than passing it through', () => {
  assert.throws(() => redactValue({ f: () => 1 }), /unsupported value at \$\.f/);
  assert.throws(() => redactValue([new Date()]), /unsupported value at \$\[0\]/);
});

test('every family has a name, a one-line reason and a global regex', () => {
  assert.equal(FAMILIES.length, 13);
  for (const f of FAMILIES) {
    assert.match(f.name, /^[a-z-]+$/);
    assert.ok(f.reason.length > 20 && !f.reason.includes('\n'), `${f.name} reason`);
    assert.ok(f.re instanceof RegExp && f.re.global, `${f.name} must be global`);
  }
});
