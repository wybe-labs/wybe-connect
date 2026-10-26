import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactValue, FAMILIES, isValidFodselsnummer } from '../lib/redact.js';

// The API of lib/redact.js: hits, options, the value walker, idempotence, positive controls.
// What each family catches and leaves alone is the frozen table's job (test/redact-table.test.js).
// Every bait is fabricated, says FAKE, and is assembled from fragments at runtime so that no
// secret-shaped literal sits in this repository; the redactor sees the full string.

const j = (...parts) => parts.join('');

const BAIT = {
  dsn: j('postgres://atlas_core:', 'Xk9$uT2vFAKEpw', '@db.example.test:5432/atlas?sslmode=require'),
  dsnPassword: 'Xk9$uT2vFAKEpw',
  wnc: j('wnc_', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1Xa9Bc2Df'),
  wbt: j('wbt_', 'FAKEfakeFAKEfake0123456789FAKEfake'),
  wat: j('wat_', 'FAKEfakeFAKEfake0123456789FAKEfake'),
  skAnt: j('sk-', 'ant-', 'api03-', 'FAKEfakeFAKEfake0123456789FAKEfake-FAKE'),
  sk: j('sk-', 'proj-', 'FAKEfakeFAKEfake0123456789FAKEfake'),
  akia: j('AK', 'IA', 'FAKEKEYID0000001'),
  awsSecret: j('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYFAKEKEY1'),
  hexValue: j('9f86d081884c7d659a2feaa0c55ad015', 'a3bf4f1b2b0b822cd15d6c15b0f00a08'),
  pem: j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEowFAKEfakeFAKEfake\n-----END ', 'RSA PRIVATE KEY-----'),
  fnrValid: j('150585', '45640'),
  email: 'eier@example.invalid',
};

const tag = (family) => `[REDACTED:${family}]`;

test('a Postgres DSN loses its userinfo, keeps scheme and host, and counts one hit', () => {
  const r = redact(`DATABASE_URL=${BAIT.dsn}`);
  assert.equal(r.text, `DATABASE_URL=postgres://${tag('url-userinfo')}@db.example.test:5432/atlas?sslmode=require`);
  assert.deepEqual(r.hits, [{ family: 'url-userinfo', count: 1 }]);
});

test('a URL without userinfo is untouched and counts nothing', () => {
  assert.deepEqual(redact('see https://docs.example.test/connect and http://127.0.0.1:8081/health').hits, []);
});

test('every Wybe prefix is covered: wnc_ wbt_ wpc_ wat_ wrt_ wac_ wcl_', () => {
  const body = BAIT.wnc.slice(4);
  for (const p of ['wnc', 'wbt', 'wpc', 'wat', 'wrt', 'wac', 'wcl']) {
    const r = redact(`${p}_${body}`);
    assert.equal(r.text, tag('wybe-credential'), `${p}_ leaked`);
    assert.deepEqual(r.hits, [{ family: 'wybe-credential', count: 1 }]);
  }
});

test('two vendor keys under their env labels count once each, under the vendor family', () => {
  const r = redact(j('ANTHROPIC_API_', 'KEY=', BAIT.skAnt, '\nOPENAI_API_', 'KEY=', BAIT.sk));
  assert.ok(!r.text.includes('FAKEfakeFAKEfake0123456789'));
  assert.deepEqual(r.hits, [{ family: 'openai-key', count: 2 }]);
});

test('an AWS key id is a vendor hit; the secret after its label is a key hit', () => {
  const r = redact(j('aws_access_key_id = ', BAIT.akia, '\naws_secret_access_', 'key = ', BAIT.awsSecret));
  assert.equal(r.text, j('aws_access_key_id = ', tag('aws-access-key'), '\naws_secret_access_', 'key = ', tag('keyed-secret')));
  assert.deepEqual(r.hits, [{ family: 'aws-access-key', count: 1 }, { family: 'keyed-secret', count: 1 }]);
});

test('a 64-hex value is redacted under client_secret; the same hex without a key is not', () => {
  assert.deepEqual(redact(j('client_', 'secret=', BAIT.hexValue)).hits, [{ family: 'keyed-secret', count: 1 }]);
  assert.deepEqual(redact(`git sha ${BAIT.hexValue}`).hits, [], 'a bare hash (git sha, content hash) must survive');
});

test('a PEM private key block is one hit, header to footer', () => {
  const r = redact(`here is the key:\n${BAIT.pem}\nend.`);
  assert.equal(r.text, `here is the key:\n${tag('pem-private-key')}\nend.`);
  assert.deepEqual(r.hits, [{ family: 'pem-private-key', count: 1 }]);
});

test('fodselsnummer control digits: a valid synthetic number verifies, a one-digit change does not', () => {
  assert.equal(isValidFodselsnummer(BAIT.fnrValid), true);
  assert.equal(isValidFodselsnummer(j('150585', '45641')), false);
  assert.equal(isValidFodselsnummer('12345678901'), false);
  assert.equal(isValidFodselsnummer(j('150585', ' 45640')), true, 'a space after the birth date is allowed');
  assert.equal(isValidFodselsnummer('1505854564'), false, 'ten digits is not a fodselsnummer');
});

test('e-mail addresses are redacted by default and kept with {emails: false}', () => {
  assert.deepEqual(redact(`write to ${BAIT.email}`), { text: `write to ${tag('email')}`, hits: [{ family: 'email', count: 1 }] });
  assert.deepEqual(redact(`write to ${BAIT.email}`, { emails: false }), { text: `write to ${BAIT.email}`, hits: [] });
});

test('POSITIVE CONTROL: disabling url-userinfo (and email, which would catch the tail of the password as an address) lets the DSN password leak', () => {
  const r = redact(`DATABASE_URL=${BAIT.dsn}`, { disable: ['url-userinfo', 'email'] });
  assert.ok(r.text.includes(BAIT.dsnPassword), 'the control did not leak, so the passing tests above prove nothing');
});

test('POSITIVE CONTROL: disabling wybe-credential and the entropy check lets the wnc_ credential leak', () => {
  assert.ok(redact(`node credential: ${BAIT.wnc}`, { disable: ['wybe-credential', 'high-entropy'] }).text.includes(BAIT.wnc));
  assert.ok(!redact(`node credential: ${BAIT.wnc}`, { disable: ['wybe-credential'] }).text.includes(BAIT.wnc), 'the entropy check is the second line');
});

test('an unknown family name in options.disable throws instead of silently protecting nothing', () => {
  assert.throws(() => redact('x', { disable: ['not-a-family'] }), /unknown family/);
});

test('hits are reported in family order and only for families that matched', () => {
  const r = redact(`${BAIT.email} ${BAIT.wnc} ${BAIT.dsn}`);
  assert.deepEqual(r.hits.map((h) => h.family), ['url-userinfo', 'wybe-credential', 'email']);
});

test('a text with nothing to redact comes back identical', () => {
  const text = 'Refactored the ingest queue; 3 files touched; ran bun test apps/ingest (42 pass).';
  assert.deepEqual(redact(text), { text, hits: [] });
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
  assert.equal(r.value.meta.n, 2);
  assert.deepEqual(r.hits, [{ family: 'url-userinfo', count: 1 }, { family: 'wybe-credential', count: 2 }]);
});

test('redactValue judges a string by its object key too: a password field goes, ids and placeholders stay', () => {
  const pw = j('Fake', 'Pw2026');
  const args = { user: 'demo', [j('pass', 'word')]: pw, [j('api_', 'key')]: 'N/A', token_count: '1200', next_page_token: 'CiAKGjBpNDd2Nmp2Zml2cXRwYjBpOXA0dHYwMBAB', nested: { [j('client_', 'secret')]: pw } };
  const r = redactValue(args);
  assert.deepEqual(r.value, { ...args, [j('pass', 'word')]: tag('keyed-secret'), nested: { [j('client_', 'secret')]: tag('keyed-secret') } });
  assert.deepEqual(r.hits, [{ family: 'keyed-secret', count: 2 }]);
  assert.equal(redactValue(args, { disable: ['keyed-secret'] }).value[j('pass', 'word')], pw, 'the key check belongs to keyed-secret');
});

test('redactValue throws on a value it does not understand rather than passing it through', () => {
  assert.throws(() => redactValue({ f: () => 1 }), /unsupported value at \$\.f/);
  assert.throws(() => redactValue([new Date()]), /unsupported value at \$\[0\]/);
});

test('every family has a name, a one-line reason and a pass', () => {
  assert.equal(FAMILIES.length, 25);
  for (const f of FAMILIES) {
    assert.match(f.name, /^[a-z-]+$/);
    assert.ok(f.reason.length > 20 && !f.reason.includes('\n'), `${f.name} reason`);
    assert.equal(typeof f.run, 'function', `${f.name} run`);
  }
});

// Idempotence: the Cursor adapter redacts each hook record as it is spooled and the flush redacts
// the built payload again (defence in depth). A second pass must neither change the text nor
// count the tags of the first pass as new hits, or the payload's `redaction.families` would lie.
test('redaction is idempotent: a second pass changes nothing and reports no hits', () => {
  const all = [...Object.values(BAIT), `Authorization: Bearer ${BAIT.wat}`, j('client_', 'secret=', BAIT.hexValue), j('{"tok', 'en": "', BAIT.wnc.slice(4), '"}')].join('\n');
  const first = redact(all);
  assert.ok(first.hits.length >= 8, 'the first pass must have work to do');
  const second = redact(first.text);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.hits, []);
});

// A transcript can hold one enormous line (minified JSON, a log). Every pass must stay linear in
// it; the bound is generous so a slow machine does not flake, a quadratic pass (tens of seconds
// on these inputs) does not pass.
test('a half-megabyte single line of pairs, JSON or headers redacts in linear time', () => {
  for (const line of ['name=demo '.repeat(50_000), '{"name":"demo","n":1},'.repeat(25_000), 'Authorization: Digest a=b '.repeat(20_000), `curl ${'-H x '.repeat(50_000)}`]) {
    const t = Date.now();
    assert.equal(redact(line).text, line);
    assert.ok(Date.now() - t < 8000, `${line.slice(0, 20)}... took ${Date.now() - t} ms`);
  }
});

test('TRAP: a userinfo that only STARTS with a redaction tag is still redacted', () => {
  const pw = j('real', 'Pw-9x');
  const r = redact(`https://${tag('url-userinfo')}:${pw}@db.example.test/x`);
  assert.ok(!r.text.includes(pw), 'a password hiding behind a tag leaked');
  assert.deepEqual(r.hits, [{ family: 'url-userinfo', count: 1 }]);
});
