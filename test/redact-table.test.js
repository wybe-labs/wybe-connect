import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../lib/redact.js';

// The frozen table (QA round 3's suggestion, and the lesson of classifier PRs that ping-pong round
// by round): every input QA rounds 1-3 used, with its exact expected output after redaction.
// Grow this table; never patch a pattern without adding the row that proves it. Secrets in the
// inputs are fabricated and assembled from parts, so the repo's own secret scanners stay quiet.
const j = (...p) => p.join('');
const JWT = [j('eyJhbGciOiJI', 'UzI1NiJ9'), j('eyJzdWIiOiJkZW1v', 'LXVzZXIifQ'), j('c2lnbmF0dXJl', 'LXBhcnQtZmFrZQ')].join('.');

/** Unchanged: ordinary text that must survive redaction exactly. */
const SAME = Symbol('same');

/** [what, input, exact expected output, or SAME] */
const TABLE = [
  ["stripe sk_live", j('sk', '_live_', '51HqTzQKx9vPq2Lm7Rt8Yw3Nb'), "[REDACTED:stripe-key]"],
  ["stripe rk_test", j('rk', '_test_', '51HqTzQKx9vPq2Lm7Rt8Yw3Nb'), "[REDACTED:stripe-key]"],
  ["stripe whsec_", j('whsec', '_', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'), "[REDACTED:stripe-key]"],
  ["google AIza", j('AIza', 'SyD3k9QxLm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1'), "[REDACTED:google-api-key]"],
  ["google GOCSPX-", j('GOCSPX', '-', 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9t'), "[REDACTED:google-api-key]"],
  ["azure AccountKey", j('DefaultEndpointsProtocol=https;AccountName=demo;Account', 'Key=', 'q8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1Xa9Bc2==', ';EndpointSuffix=core.windows.net'), "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=[REDACTED:azure-key];EndpointSuffix=core.windows.net"],
  ["azure SAS sig=", j('https://acct.blob.core.windows.net/c/f?sv=2022-11-02&sp=r&sig=', 'q8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1Xa9B%3D'), "https://acct.blob.core.windows.net/c/f?sv=2022-11-02&sp=r&sig=[REDACTED:azure-key]"],
  ["password= short", j('pass', 'word=', 'Sommer2026!'), "password=[REDACTED:password-assignment]"],
  ["pwd= 5 chars", j('pwd=', 'ab12x'), "pwd=[REDACTED:password-assignment]"],
  ["passphrase quoted with spaces", j('passphrase: "', 'correct horse battery staple', '"'), "passphrase: [REDACTED:password-assignment]"],
  ["DB_PASSWORD env", j('DB_PASS', 'WORD=', 'Sup3rS3cret'), "DB_PASSWORD=[REDACTED:password-assignment]"],
  ["POSTGRES_PASSWORD env", j('POSTGRES_PASS', 'WORD=', 'hunter2hunter2'), "POSTGRES_PASSWORD=[REDACTED:password-assignment]"],
  ["PGPASSWORD before psql", j('PGPASS', 'WORD=', 'hunter2hunter2', ' psql -h db'), "PGPASSWORD=[REDACTED:password-assignment] psql -h db"],
  ["MY_API_KEY env, 32 hex", j('MY_API_KEY=', 'a1b2c3d4e5f6a7b8', 'c9d0e1f2a3b4c5d6'), "MY_API_KEY=[REDACTED:generic-secret]"],
  ["SLACK_SIGNING_SECRET env", j('SLACK_SIGNING_SECRET=', 'a1b2c3d4e5f6a7b8', 'c9d0e1f2a3b4c5d6'), "SLACK_SIGNING_SECRET=[REDACTED:generic-secret]"],
  ["NEXTAUTH_SECRET env", j('NEXTAUTH_SECRET=', 'Q7vXk2Lm9PzR', '4tWy8NbC3dFh6JsA1eGu'), "NEXTAUTH_SECRET=[REDACTED:generic-secret]"],
  ["GOOGLE_CLIENT_SECRET env", j('GOOGLE_CLIENT_SECRET=', 'Q7vXk2Lm9PzR', '4tWy8NbC3dFh6JsA1eGu'), "GOOGLE_CLIENT_SECRET=[REDACTED:generic-secret]"],
  ["Authorization: Basic with digits", j('Authorization: Basic ', 'ZGVtbzpQbDRudGVkLVB3'), "Authorization: Basic [REDACTED:basic-auth]"],
  ["Authorization: Basic no digit", j('Authorization: Basic ', 'dXNlcjpwYXNz'), "Authorization: Basic [REDACTED:basic-auth]"],
  ["Authorization:Basic no space", j('Authorization:Basic ', 'dXNlcjpwYXNz'), "Authorization:Basic [REDACTED:basic-auth]"],
  ["Basic with æøå password", j('Authorization: Basic ', Buffer.from(j('demo:', 'pålogging2026'), 'utf8').toString('base64')), "Authorization: Basic [REDACTED:basic-auth]"],
  ["Authorization: Token", j('Authorization: Token ', '9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b'), "Authorization: Token [REDACTED:bearer]"],
  ["lowercase bearer", j('authorization: bearer ', 'abc123def456ghi789'), "authorization: bearer [REDACTED:bearer]"],
  ["PGP private key block", j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\nlQOYBF0SECRETBODYxyz\n-----END PGP ', 'PRIVATE KEY BLOCK-----'), "[REDACTED:pem-private-key]"],
  ["PEM without END line", j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC'), "[REDACTED:pem-private-key]"],
  ["PEM with CRLF", j('-----BEGIN RSA ', 'PRIVATE KEY-----\r\nMIIEowIBAAKCAQEAyVxq\r\n-----END RSA ', 'PRIVATE KEY-----'), "[REDACTED:pem-private-key]"],
  ["aws-cli SecretAccessKey", j('"SecretAccessKey": "', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKEKEY1', '"'), "\"SecretAccessKey\": \"[REDACTED:aws-secret]\""],
  ["AWS ASIA key id", j('AS', 'IA', 'QAFAKEKEYID00001'), "[REDACTED:aws-access-key]"],
  ["curl -u user:pw", j('curl -u admin:', 'Hunter22x', ' https://api.example.test'), "curl -u admin:[REDACTED:curl-user] https://api.example.test"],
  ["Slack webhook URL", j('https://hooks.slack.com/services/', 'T0FAKE000/B0FAKE000/QAfakeQAfakeQAfakeQAfake'), "https://hooks.slack.com/services/[REDACTED:slack-webhook]"],
  ["JWT at end of sentence", j('Use this token: ', JWT, '.'), "Use this token: [REDACTED:jwt]."],
  ["JWT then period mid-text", j('token ', JWT, '. Then call the API'), "token [REDACTED:jwt]. Then call the API"],
  ["JWT in URL query", j('https://app.example.test/cb?id_token=', JWT, '&x=1'), "https://app.example.test/cb?id_token=[REDACTED:jwt]&x=1"],
  ["github_pat_", j('github_', 'pat_', '11ABCDEFG0abcdefghijklmnopqrstuvwxyz'), "[REDACTED:github-token]"],
  ["prose: Bearer authentication", 'The node API uses Bearer authentication through Atlas', SAME],
  ["prose: basic auth deprecated", 'basic auth is deprecated, use OAuth', SAME],
  ["prose: Basic usage", 'Basic usage of the API', SAME],
  ["prose: token bucket", 'rate limit uses a token bucket of 60 per minute', SAME],
  ["prose: the key: value pair", 'the key: value pair is stored in node_state', SAME],
  ["prose: password is in the vault", 'the password is in the vault', SAME],
  ["TS type: password: string", 'type Login = { password: string; remember: boolean }', SAME],
  ["markdown type after password", '| password | `string` | required |', SAME],
  ["placeholder <your password>", 'set password: <your password> in the form', SAME],
  ["env reference ${DB_PASSWORD}", j('pass', 'word=${DB_PASSWORD}'), SAME],
  ["Python Optional[str]", j('def login(user: str, pass', 'word: Optional[str] = None):'), SAME],
  ["os.getenv call", j('pass', 'word = os.getenv("DB_PASS")'), SAME],
  ["JS req.body field", j('const pass', 'word = req.body.pass', 'word;'), SAME],
  ["idempotency key uuid", 'idempotency key: 123e4567-e89b-12d3-a456-426614174000', SAME],
  ["ssh:// git remote", 'remote is ssh://git@github.com/wybe-labs/wybe-connect.git', SAME],
  ["scp-style git remote", 'git clone git@github.com:wybe-labs/wybe-connect.git', SAME],
  ["git remote -v line", 'origin\tgit@github.com:wybe-labs/wybe-connect.git (fetch)', SAME],
  ["https git URL", 'https://github.com/wybe-labs/wybe-connect.git', SAME],
  ["publishable pk_live", j('pk', '_live_', '51HqTzQKx9vPq2Lm7Rt8Yw3Nb'), SAME],
  ["plain uuid", 'request 123e4567-e89b-12d3-a456-426614174000 failed', SAME],
  ["long hex sha", 'commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 landed', SAME],
];

for (const [what, input, expected] of TABLE) {
  test(`table: ${what}`, () => {
    const want = expected === SAME ? input : expected;
    assert.equal(redact(input).text, want);
    assert.equal(redact(want).text, want, 'idempotent');
  });
}
