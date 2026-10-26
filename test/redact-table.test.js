import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, FAMILIES } from '../lib/redact.js';

// The frozen table: every input any review of the redactor has used, leaks and false positives
// alike, with its EXACT expected output, and the check that a second pass changes nothing.
// Grow this table; never change a rule without the row that proves it. Secrets in the inputs are
// fabricated and assembled from parts so that no scanner mistakes them for live ones, and every
// vendor-shaped body says FAKE (or fake). The last test switches off each family in turn: every
// family must turn at least one row red, or the table proves nothing about it.
// Rows use only j, JWT, SAME and Buffer, so the table can be read and evaluated on its own.
const j = (...p) => p.join('');
const JWT = [j('eyJhbGciOiJI', 'UzI1NiJ9'), j('eyJzdWIiOiJkZW1v', 'LXVzZXIifQ'), j('c2lnbmF0dXJl', 'LXBhcnQtZmFrZQ')].join('.');

/** Unchanged: ordinary text that must survive redaction exactly. */
const SAME = Symbol('same');

/** [what, input, exact expected output, or SAME] */
const TABLE = [
  // ---------------------------------------------------------------- private key blocks
  ['PGP private key block', j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\nlQOYBF0SECRETBODYxyz\n-----END PGP ', 'PRIVATE KEY BLOCK-----'), '[REDACTED:pem-private-key]'],
  ['PGP private key block, lowercase in the body', j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\nlQOYBF0abcdefSECRETBODYxyz\n-----END PGP ', 'PRIVATE KEY BLOCK-----'), '[REDACTED:pem-private-key]'],
  ['PEM without END line', j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC'), '[REDACTED:pem-private-key]'],
  ['PEM without END line, longer body', j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'), '[REDACTED:pem-private-key]'],
  ['RSA key with CRLF', j('-----BEGIN RSA ', 'PRIVATE KEY-----\r\nMIIEowIBAAKCAQEAyVxq\r\n-----END RSA ', 'PRIVATE KEY-----'), '[REDACTED:pem-private-key]'],
  ['RSA key, CRLF after END', j('-----BEGIN RSA ', 'PRIVATE KEY-----\r\nMIIEowIBAAKCAQEA', 'Q7vXk2Lm9P', 'zR4tWy8NbC', '\r\n-----END RSA ', 'PRIVATE KEY-----\r\n'), '[REDACTED:pem-private-key]\r\n'],
  ['RSA key of two body lines, text after it', j('-----BEGIN RSA ', 'PRIVATE KEY-----\r\nMIIEowIBAAKCAQEA', 'Q7vXk2Lm9PzR4tWy8NbC3dFh6JsA1eGu', '\r\n', 'Q7vXk2Lm9PzR4tWy8NbC3dFh6JsA1eGu', '\r\n-----END RSA ', 'PRIVATE KEY-----\r\nafter'), '[REDACTED:pem-private-key]\r\nafter'],
  ['RSA key, short body', j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx\n-----END RSA ', 'PRIVATE KEY-----'), '[REDACTED:pem-private-key]'],
  ['OPENSSH key', j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUFAKEFAKE\n-----END OPENSSH ', 'PRIVATE KEY-----'), '[REDACTED:pem-private-key]'],
  ['EC key', j('-----BEGIN EC ', 'PRIVATE KEY-----\nMHcCAQEEIFAKEFAKE\n-----END EC ', 'PRIVATE KEY-----'), '[REDACTED:pem-private-key]'],
  ['ENCRYPTED key', j('-----BEGIN ENCRYPTED ', 'PRIVATE KEY-----\nMIIFHzBJBgkqFAKE\n-----END ENCRYPTED ', 'PRIVATE KEY-----'), '[REDACTED:pem-private-key]'],
  ['key block inside prose', j('here is the key:\n-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEowFAKEfakeFAKE\n-----END RSA ', 'PRIVATE KEY-----\nend.'), 'here is the key:\n[REDACTED:pem-private-key]\nend.'],
  ['key block after a note label', j('Deploy note: -----BEGIN ', 'PRIVATE KEY-----\nMIIEvFAKEfakeFAKEfake\n-----END ', 'PRIVATE KEY-----'), 'Deploy note: [REDACTED:pem-private-key]'],
  ['ordinary: a public key block', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AFAKE\n-----END PUBLIC KEY-----', SAME],

  // ---------------------------------------------------------------- YAML block scalars
  ['yaml block scalar under password', j('db:\n  pass', 'word: |\n    fake-multi', '-line-pw\n'), j('db:\n  pass', 'word: |\n    ', '[REDACTED:secret-block]', '\n')],
  ['yaml block scalar, second plain line', j('db:\n  pass', 'word: |\n    fake-multi', '-line-pw\n    second-line\n'), j('db:\n  pass', 'word: |\n    ', '[REDACTED:secret-block]', '\n')],
  ['yaml folded scalar under password', j('db:\n  pass', 'word: >-\n    fake-folded', '-pw-123\n'), j('db:\n  pass', 'word: >-\n    ', '[REDACTED:secret-block]', '\n')],
  ['yaml block of two lines under client_secret, next key kept', j('app:\n  client_', 'secret: |\n    line-one-FAKE\n    line-two-FAKE\n  name: demo\n'), j('app:\n  client_', 'secret: |\n    ', '[REDACTED:secret-block]', '\n  name: demo\n')],
  ['yaml block with CRLF', j('db:\r\n  pass', 'word: |-\r\n    fake-crlf-pw\r\n  port: 5432\r\n'), j('db:\r\n  pass', 'word: |-\r\n    ', '[REDACTED:secret-block]', '\r\n  port: 5432\r\n')],
  ['yaml block under a list item', j('users:\n  - pass', 'word: |\n      FakeBlockPw2026\n'), j('users:\n  - pass', 'word: |\n      ', '[REDACTED:secret-block]', '\n')],
  ['yaml block under a quoted key', j('"pass', 'word": |\n  FakeBlockPw2026\n'), j('"pass', 'word": |\n  ', '[REDACTED:secret-block]', '\n')],
  ['yaml block with a comment after the indicator', j('app_', 'secret: |  # rotated monthly\n  FakeBlockSecret2026\n'), j('app_', 'secret: |  # rotated monthly\n  ', '[REDACTED:secret-block]', '\n')],
  ['yaml block with a blank line inside', j('app_', 'secret: |\n  FakeLineOne\n\n  FakeLineAfterBlank\n'), j('app_', 'secret: |\n  ', '[REDACTED:secret-block]', '\n')],
  ['yaml block with a blank line before the value', j('tok', 'en: |\n\n  FakeTokenAfterBlank\n'), j('tok', 'en: |\n\n  ', '[REDACTED:secret-block]', '\n')],
  ['yaml block whose last line is a key block', j('tls_', 'secret: |\n  FakePassphrase2026\n  -----BEGIN ', 'PRIVATE KEY-----\n  MIIfake\n  -----END ', 'PRIVATE KEY-----\n'), j('tls_', 'secret: |\n  ', '[REDACTED:secret-block]', '\n')],
  ['yaml secret block holding nested yaml: only the nested password goes', j('secret: |\n  user: demo\n  pass', 'word: FakeNestedPw2026\n'), j('secret: |\n  user: demo\n  pass', 'word: ', '[REDACTED:keyed-secret]', '\n')],
  ['ordinary: yaml block under description', 'description: |\n  the password is rotated monthly\n', SAME],
  ['ordinary: helm secret block holding a ConfigMap', 'secret: |\n  apiVersion: v1\n  kind: ConfigMap\n', SAME],
  ['ordinary: helm template under tls_key', 'tls_key: |\n  {{ .Values.tls.key | nindent 4 }}\n', SAME],
  ['ordinary: env reference under ssh_key', 'ssh_key: |\n  ${SSH_KEY}\n', SAME],
  ['ordinary: ssh public key under public_key', 'public_key: |\n  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEfakeFAKE demo@laptop\n', SAME],
  ['ordinary: primary_key block', 'primary_key: |\n  id\n', SAME],
  ['ordinary: foreign_key block', 'foreign_key: |\n  user_id references users(id)\n', SAME],
  ['ordinary: sort_key folded', 'sort_key: >\n  created_at desc\n', SAME],
  ['ordinary: cache_key block with a template', 'cache_key: |\n  v1-deps-{{ checksum "package-lock.json" }}\n', SAME],
  ['ordinary: token folded prose', 'token: >\n  The token is valid for 1 hour.\n  Refresh it with the refresh flow.\n', SAME],
  ['ordinary: markdown fence with a private_key placeholder', '```yaml\nprivate_key: |\n  see docs\n```', SAME],

  // ---------------------------------------------------------------- URL userinfo
  ['postgres DSN in an env line', j('DATABASE_URL=postgres://atlas_core:', 'Xk9$uT2vFAKE', '@db.example.test:5432/atlas?sslmode=require'), 'DATABASE_URL=postgres://[REDACTED:url-userinfo]@db.example.test:5432/atlas?sslmode=require'],
  ['postgres DSN, short password', j('postgres://app:', 'S3cretPw', '@db.example.test:5432/app'), 'postgres://[REDACTED:url-userinfo]@db.example.test:5432/app'],
  ['postgres DSN, fake password', j('postgres://app:', 'FakePw2026', '@db.example.test:5432/app'), 'postgres://[REDACTED:url-userinfo]@db.example.test:5432/app'],
  ['https userinfo password', j('https://alice:', 'FakePw2026', '@db.example.test/app'), 'https://[REDACTED:url-userinfo]@db.example.test/app'],
  ['https userinfo, two-character password', j('https://alice:', 'xy', '@db.example.test/app'), 'https://[REDACTED:url-userinfo]@db.example.test/app'],
  ['two URLs with userinfo', j('curl https://deploy:', 's3cr3t-pw', '@registry.example.test/v2/ and redis://:', 'hunter2', '@cache:6379'), 'curl https://[REDACTED:url-userinfo]@registry.example.test/v2/ and redis://[REDACTED:url-userinfo]@cache:6379'],
  ['a password hiding behind an earlier tag', j('https://[REDACTED:url-userinfo]:', 'realPw-9x', '@db.example.test/x'), 'https://[REDACTED:url-userinfo]@db.example.test/x'],
  ['a token as the userinfo', j('https://x-access-token:', 'ghp_', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake0123', '@github.com/wybe-labs/x.git'), 'https://[REDACTED:url-userinfo]@github.com/wybe-labs/x.git'],
  ['ordinary: ssh:// git remote', 'remote is ssh://git@github.com/wybe-labs/wybe-connect.git', SAME],
  ['ordinary: ssh:// remote after a word', 'remote ssh://git@github.com/wybe-labs/wybe-connect.git', SAME],
  ['ordinary: scp-style git remote', 'git clone git@github.com:wybe-labs/wybe-connect.git', SAME],
  ['ordinary: git remote -v line', 'origin\tgit@github.com:wybe-labs/wybe-connect.git (fetch)', SAME],
  ['ordinary: https git URL', 'https://github.com/wybe-labs/wybe-connect.git', SAME],
  ['ordinary: ssh remote with port 22', 'ssh://git@github.com:22/wybe-labs/wybe-connect.git', SAME],
  ['ordinary: ssh remote with port 2222', 'ssh://git@gitlab.example.test:2222/team/repo.git', SAME],
  ['ordinary: ssh remote over 443', 'git clone ssh://git@ssh.github.com:443/wybe-labs/wybe-connect.git', SAME],
  ['ordinary: URLs without userinfo', 'see https://docs.example.test/connect and http://127.0.0.1:8081/health', SAME],
  ['ordinary: git push origin <branch>', 'git push origin feat/import-distil', SAME],

  // ---------------------------------------------------------------- Authorization headers
  ['Authorization: Bearer with a Wybe token', j('Authorization: Bearer ', 'wat_', 'FAKEfakeFAKEfake0123456789FAKEfake'), 'Authorization: Bearer [REDACTED:auth-header]'],
  ['Authorization: Bearer with a JWT', j('Authorization: Bearer ', JWT), 'Authorization: Bearer [REDACTED:auth-header]'],
  ['Authorization: Bearer after a note label', j('Deploy note: Authorization: Bearer ', JWT), 'Deploy note: Authorization: Bearer [REDACTED:auth-header]'],
  ['lowercase authorization: bearer', j('authorization: bearer ', 'abc123def456ghi789'), 'authorization: bearer [REDACTED:auth-header]'],
  ['Authorization: Bearer, mixed case and digits', j('Authorization: Bearer ', 'abcDEF123456ghiJKL'), 'Authorization: Bearer [REDACTED:auth-header]'],
  ['bare Bearer, letters only but mixed case', j('Bearer ', 'abcdefghijklmnop', 'qrstuvwxyzABCD'), 'Bearer [REDACTED:auth-header]'],
  ['Authorization: Token', j('Authorization: Token ', 'FAKE9944b09199c62bcf9418ad846dd0e4bb'), 'Authorization: Token [REDACTED:auth-header]'],
  ['Authorization: Basic with digits', j('Authorization: Basic ', 'ZGVtbzpQbDRudGVkLVB3'), 'Authorization: Basic [REDACTED:auth-header]'],
  ['Authorization: Basic, no digit', j('Authorization: Basic ', 'dXNlcjpwYXNz'), 'Authorization: Basic [REDACTED:auth-header]'],
  ['Authorization:Basic, no space', j('Authorization:Basic ', 'dXNlcjpwYXNz'), 'Authorization:Basic [REDACTED:auth-header]'],
  ['Authorization:Basic, no space, other password', j('Authorization:Basic ', Buffer.from(j('demo:', 'hunter2x'), 'utf8').toString('base64')), 'Authorization:Basic [REDACTED:auth-header]'],
  ['Basic with an æøå password', j('Authorization: Basic ', Buffer.from(j('demo:', 'pålogging2026'), 'utf8').toString('base64')), 'Authorization: Basic [REDACTED:auth-header]'],
  ['Basic inside a curl -H', j('curl -H "Authorization: Basic ', Buffer.from(j('demo:', 'pw12'), 'utf8').toString('base64'), '" https://x.test'), 'curl -H "Authorization: Basic [REDACTED:auth-header]" https://x.test'],
  ['Basic credential without the header name', j('use Basic ', Buffer.from(j('demo:', 'FakePw2026'), 'utf8').toString('base64'), ' for the smoke test'), 'use Basic [REDACTED:auth-header] for the smoke test'],
  ['Digest response', j('Authorization: Digest username="demo", realm="r", nonce="n", response="', 'fa4efa4efa4efa4e', 'fa4efa4efa4efa4e', '"'), 'Authorization: Digest username="demo", realm="r", nonce="n", response="[REDACTED:auth-header]"'],
  ['Authorization in a JSON headers object', j('{"headers":{"Authorization":"Bearer ', 'FAKEfakeFAKE0123456789', '"}}'), '{"headers":{"Authorization":"Bearer [REDACTED:auth-header]"}}'],
  ['ordinary: prose about Bearer authentication', 'The node API uses Bearer authentication through Atlas', SAME],
  ['ordinary: basic auth is deprecated, use OAuth', 'basic auth is deprecated, use OAuth', SAME],
  ['ordinary: basic auth is deprecated', 'basic auth is deprecated', SAME],
  ['ordinary: Basic authentication is deprecated', 'Basic authentication is deprecated', SAME],
  ['ordinary: Basic usage of the API', 'Basic usage of the API', SAME],
  ['ordinary: Basic configuration needed', 'Basic configuration needed', SAME],
  ['ordinary: Use Basic auth here', 'Use Basic auth here', SAME],
  ['ordinary: Basic Settings and Basic+ plan', 'Basic Settings page and Basic+ plan', SAME],
  ['ordinary: Basic Auth: in settings', 'Basic Auth: enable it in settings', SAME],
  ['ordinary: Bearer placeholder <token>', 'Authorization: Bearer <token>', SAME],
  ['ordinary: Bearer env reference', 'Authorization: Bearer ${TOKEN}', SAME],
  ['ordinary: Bearer shell variable', 'Authorization: Bearer $TOKEN', SAME],

  // ---------------------------------------------------------------- cookies
  ['Cookie: session=', j('Cookie: session=', 'FAKEfakeFAKEfake', '0123456789abcdef', 'FAKE'), 'Cookie: session=[REDACTED:cookie]'],
  ['Set-Cookie: session=, attributes kept', j('Set-Cookie: session=', 'FAKEfakeFAKEfake', '0123456789abcdef', 'FAKE; HttpOnly; Secure'), 'Set-Cookie: session=[REDACTED:cookie]; HttpOnly; Secure'],
  ['Cookie of two pairs, the short one kept', j('Cookie: theme=dark; sid=', 'FAKEfake0123456789'), 'Cookie: theme=dark; sid=[REDACTED:cookie]'],
  ['ordinary: prose about the Cookie header', 'the Cookie: header carries the session', SAME],

  // ---------------------------------------------------------------- CLI flags
  ['--password, a space, the value', j('psql --pass', 'word FakeSecret9 --host db'), j('psql --pass', 'word ', '[REDACTED:cli-secret]', ' --host db')],
  ['--password=value', j('mysqldump --pass', 'word=FakeSecret9 app'), j('mysqldump --pass', 'word=', '[REDACTED:cli-secret]', ' app')],
  ['--token after a flag without a value', j('gh auth login --with-token --tok', 'en ', 'FAKEfake0123456789'), j('gh auth login --with-token --tok', 'en ', '[REDACTED:cli-secret]')],
  ['docker login -p', j('docker login -u demo -p ', 'FakeDockerPw1', ' registry.example.test'), j('docker login -u demo -p ', '[REDACTED:cli-secret]', ' registry.example.test')],
  ['mysql -p<pw>', j('mysql -u root -p', 'FakeSecret9', ' app'), j('mysql -u root -p', '[REDACTED:cli-secret]', ' app')],
  ['curl -u user:pw', j('curl -u admin:', 'Hunter22x', ' https://api.example.test'), j('curl -u admin:', '[REDACTED:cli-secret]', ' https://api.example.test')],
  ['ordinary: docker login --password-stdin', 'docker login --password-stdin < pw.txt', SAME],
  ['ordinary: psql --password with no value', 'psql --password --host db', SAME],
  ['ordinary: mkdir -p', 'mkdir -p build/output', SAME],
  ['ordinary: ssh -p port', 'ssh -p 2222 build-box', SAME],
  ['ordinary: --max-tokens 4096', 'npm run eval -- --max-tokens 4096', SAME],

  // ---------------------------------------------------------------- vendor prefixes
  ['Wybe node credential', j('node credential: ', 'wnc_', 'FAKEfakeFAKEfake_0123456789-FAKEfake'), 'node credential: [REDACTED:wybe-credential]'],
  ['Wybe bearer token in an env line', j('WYBE_TOK', 'EN=', 'wbt_', 'FAKEfakeFAKEfake0123456789'), j('WYBE_TOK', 'EN=', '[REDACTED:wybe-credential]')],
  ['OpenAI project key', j('OPENAI_API_', 'KEY=', 'sk-', 'proj-', 'FAKEfakeFAKEfake0123456789FAKEfake'), j('OPENAI_API_', 'KEY=', '[REDACTED:openai-key]')],
  ['Anthropic key', j('sk-', 'ant-', 'api03-', 'FAKEfakeFAKEfake0123456789FAKEfake-FAKE'), '[REDACTED:openai-key]'],
  ['AWS ASIA key id', j('AS', 'IA', 'QAFAKEKEYID00001'), '[REDACTED:aws-access-key]'],
  ['AWS AKIA key id after its label', j('aws_access_key_id = ', 'AK', 'IA', 'FAKEKEYID0000001'), j('aws_access_key_id = ', '[REDACTED:aws-access-key]')],
  ['github_pat_', j('github_', 'pat_', '11ABCDEFG0abcdefghijklmnopqrstuvwxyz'), '[REDACTED:github-token]'],
  ['github_pat_ in its <22>_<59> shape', j('token github_', 'pat_', '11ABCDEFG0abcdefghijkl', '_mnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij'), 'token [REDACTED:github-token]'],
  ['github_pat_ in an env line', j('GITHUB_', 'TOKEN=github_', 'pat_', '11ABCDEFG0', 'abcdefghijkl_', 'mnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij'), j('GITHUB_', 'TOKEN=', '[REDACTED:github-token]')],
  ['ghp_ token', j('gh', 'p_', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake0123'), '[REDACTED:github-token]'],
  ['gho_ token', j('gh', 'o_', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake0123'), '[REDACTED:github-token]'],
  ['ghp_ token in an .npmrc line', j('//npm.pkg.github.com/:_auth', 'Token=', 'gh', 'p_', 'FAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKE'), j('//npm.pkg.github.com/:_auth', 'Token=', '[REDACTED:github-token]')],
  ['GitLab glpat-', j('glpat', '-', 'abcdefghij0123456789'), '[REDACTED:gitlab-token]'],
  ['bare npm_ token', j('npm publish failed with token npm_', 'FakeFakeFakeFakeFakeFakeFakeFake1234'), 'npm publish failed with token [REDACTED:npm-token]'],
  ['npm_ token in .npmrc', j('//registry.npmjs.org/:_auth', 'Token=', 'npm_', 'FakeFakeFakeFakeFakeFakeFakeFake1234'), j('//registry.npmjs.org/:_auth', 'Token=', '[REDACTED:npm-token]')],
  ['npm_ token in an env line', j('NPM_', 'TOKEN=', 'npm_', 'FakeFakeFakeFakeFakeFakeFakeFake1234'), j('NPM_', 'TOKEN=', '[REDACTED:npm-token]')],
  ['Slack bot token', j('SLACK_BOT_', 'TOKEN=', 'xo', 'xb-', '0000FAKE0000-0000FAKE0000-FAKEfakeFAKEfakeFAKEfake'), j('SLACK_BOT_', 'TOKEN=', '[REDACTED:slack-token]')],
  ['Slack app-level token xapp-', j('xa', 'pp-1-', 'A0FAKE-000000000000-', 'fakefakefakefake', 'fakefakefake'), '[REDACTED:slack-token]'],
  ['Slack webhook URL', j('https://hooks.slack.com/services/', 'T0FAKE000/B0FAKE000/QAfakeQAfakeQAfakeQAfake'), 'https://hooks.slack.com/services/[REDACTED:slack-webhook]'],
  ['Stripe sk_live', j('sk', '_live_', 'FAKE0fake0FAKE0fake0FAKE0'), '[REDACTED:stripe-key]'],
  ['Stripe sk_live after a note label', j('Deploy note: sk', '_live_', 'FAKE0fake0FAKE0fake0FAKE0'), 'Deploy note: [REDACTED:stripe-key]'],
  ['Stripe sk_test', j('sk', '_test_', 'FAKE0fake0FAKE0fake0FAKE0'), '[REDACTED:stripe-key]'],
  ['Stripe rk_test', j('rk', '_test_', 'FAKE0fake0FAKE0fake0FAKE0'), '[REDACTED:stripe-key]'],
  ['Stripe rk_live in an env line', j('STRIPE=rk', '_live_', 'FAKE0fake0FAKE0fake0FAKE0'), 'STRIPE=[REDACTED:stripe-key]'],
  ['Stripe whsec_', j('wh', 'sec_', 'FAKEfakeFAKEfake0123456789abcdef'), '[REDACTED:stripe-key]'],
  ['Google AIza', j('AI', 'za', 'SyFAKEfakeFAKEfakeFAKEfakeFAKEfa'), '[REDACTED:google-api-key]'],
  ['Google AIza in prose', j('maps key AI', 'za', 'SyFAKEfakeFAKEfakeFAKEfakeFAKEfa'), 'maps key [REDACTED:google-api-key]'],
  ['Google GOCSPX-', j('GOC', 'SPX-', 'FAKEfakeFAKEfake01234567'), '[REDACTED:google-api-key]'],
  ['SendGrid SG.', j('S', 'G.', 'FAKEfakeFAKEfake012345', '.', 'FAKEfakeFAKEfake0123456789', 'FAKEfakeFAKEfake0'), '[REDACTED:sendgrid-key]'],
  ['Twilio API key SK + 32 hex', j('S', 'K', 'fa4efa4efa4efa4e', 'fa4efa4efa4efa4e'), '[REDACTED:twilio-key]'],
  ['Discord bot token in an env line', j('DISCORD_', 'TOKEN=', 'MTAFAKEfakeFAKEfakeFAKEfake', '.GFAKE0.', 'fakeFAKEfakeFAKE', 'fakeFAKEfakeFAKEfake'), j('DISCORD_', 'TOKEN=', '[REDACTED:discord-token]')],
  ['Microsoft refresh token 0.A', j('{"refresh_', 'token":"0.AXoA', 'FAKEfakeFAKEfake0123456789', '-FAKEfakeFAKEfake0123456789_FAKEfake"}'), j('{"refresh_', 'token":"', '[REDACTED:microsoft-token]', '"}')],
  ['JWT at the end of a sentence', j('Use this token: ', JWT, '.'), 'Use this token: [REDACTED:jwt].'],
  ['JWT, a period, more text', j('token ', JWT, '. Then call the API'), 'token [REDACTED:jwt]. Then call the API'],
  ['JWT after "The token is"', j('The token is ', JWT, '.'), 'The token is [REDACTED:jwt].'],
  ['JWT in a URL query', j('https://app.example.test/cb?id_token=', JWT, '&x=1'), 'https://app.example.test/cb?id_token=[REDACTED:jwt]&x=1'],
  ['JWT in a URL query, state after it', j('https://app.example.test/cb?id_token=', JWT, '&state=abc'), 'https://app.example.test/cb?id_token=[REDACTED:jwt]&state=abc'],
  ['JWT in a callback line', j('callback https://app.example.test/cb?id_token=', JWT, '&state=abc'), 'callback https://app.example.test/cb?id_token=[REDACTED:jwt]&state=abc'],
  ['JWT as a URL path segment', j('https://app.example.test/verify/', JWT), 'https://app.example.test/verify/[REDACTED:jwt]'],
  ['JWT as a URL path segment after see', j('see https://app.example.test/verify/', JWT), 'see https://app.example.test/verify/[REDACTED:jwt]'],
  ['JWT in a markdown link target', j('[log in](https://app.example.test/cb?token=', JWT, ')'), '[log in](https://app.example.test/cb?token=[REDACTED:jwt])'],
  ['JWT as a bare markdown link', j('[token](', JWT, ')'), '[token]([REDACTED:jwt])'],
  ['JWT as markdown link text', j('see [', JWT, '](https://x.test)'), 'see [[REDACTED:jwt]](https://x.test)'],
  ['JWT as a cookie-style assignment', j('session=', JWT, ';'), 'session=[REDACTED:jwt];'],
  ['ordinary: wnc_ and wbt_x as words', 'the wnc_ prefix and wbt_x are just words here', SAME],
  ['ordinary: npm_config_cache', 'npm reads npm_config_cache from the environment', SAME],
  ['ordinary: publishable pk_live', j('pk', '_live_', 'FAKE0fake0FAKE0fake0FAKE0'), SAME],
  ['ordinary: Twilio account sid', j('account A', 'C', 'fa4efa4efa4efa4e', 'fa4efa4efa4efa4e'), SAME],

  // ---------------------------------------------------------------- by key: env, dotenv, shell
  ['password= short', j('pass', 'word=', 'Sommer2026!'), j('pass', 'word=', '[REDACTED:keyed-secret]')],
  ['password= after a note label', j('Deploy note: pass', 'word=', 'FakePw2026'), j('Deploy note: pass', 'word=', '[REDACTED:keyed-secret]')],
  ['passord: Norwegian label', j('pass', 'ord: ', 'Sommer2026!'), j('pass', 'ord: ', '[REDACTED:keyed-secret]')],
  ['pwd= 5 chars', j('pw', 'd=', 'ab12x'), j('pw', 'd=', '[REDACTED:keyed-secret]')],
  ['DB_PASSWORD env', j('DB_PASS', 'WORD=', 'Sup3rS3cret'), j('DB_PASS', 'WORD=', '[REDACTED:keyed-secret]')],
  ['DB_PASSWORD env with - and !', j('DB_PASS', 'WORD=', 'Sup3r-S3cret!'), j('DB_PASS', 'WORD=', '[REDACTED:keyed-secret]')],
  ['DB_PASSWORD = value, spaces round =', j('DB_PASS', 'WORD = ', 'FakePw2026'), j('DB_PASS', 'WORD = ', '[REDACTED:keyed-secret]')],
  ['DB_PASSWORD = "value"', j('DB_PASS', 'WORD = "', 'FakePw2026', '"'), j('DB_PASS', 'WORD = "', '[REDACTED:keyed-secret]', '"')],
  ['POSTGRES_PASSWORD env', j('POSTGRES_PASS', 'WORD=', 'hunter2hunter2'), j('POSTGRES_PASS', 'WORD=', '[REDACTED:keyed-secret]')],
  ['PGPASSWORD before psql', j('PGPASS', 'WORD=', 'hunter2hunter2', ' psql -h db'), j('PGPASS', 'WORD=', '[REDACTED:keyed-secret]', ' psql -h db')],
  ['PGPASSWORD before psql, short form', j('PGPASS', 'WORD=', 'hunter2hunter2', ' psql'), j('PGPASS', 'WORD=', '[REDACTED:keyed-secret]', ' psql')],
  ['PGPASSWORD=x, one character', j('PGPASS', 'WORD=x psql -h db'), j('PGPASS', 'WORD=', '[REDACTED:keyed-secret]', ' psql -h db')],
  ['export DB_PASSWORD="x y"', j('export DB_PASS', 'WORD="x y"'), j('export DB_PASS', 'WORD="', '[REDACTED:keyed-secret]', '"')],
  ['export DB_PASSWORD="fake pass phrase"', j('export DB_PASS', 'WORD="fake pass phrase"'), j('export DB_PASS', 'WORD="', '[REDACTED:keyed-secret]', '"')],
  ['export DB_PASSWORD=value', j('export DB_PASS', 'WORD=', 'FakePw2026'), j('export DB_PASS', 'WORD=', '[REDACTED:keyed-secret]')],
  ['export DB_PASS=value', j('export DB_PA', 'SS=', 'hunter2hunter2'), j('export DB_PA', 'SS=', '[REDACTED:keyed-secret]')],
  ['set DB_PASSWORD=value (cmd)', j('set DB_PASS', 'WORD=', 'FakePw2026'), j('set DB_PASS', 'WORD=', '[REDACTED:keyed-secret]')],
  ['$env:DB_PASSWORD = "value" (PowerShell)', j('$env:DB_PASS', 'WORD = "', 'FakePw2026', '"'), j('$env:DB_PASS', 'WORD = "', '[REDACTED:keyed-secret]', '"')],
  ['MY_API_KEY env, 32 hex', j('MY_API_', 'KEY=', 'a1b2c3d4e5f6a7b8', 'c9d0e1f2a3b4c5d6'), j('MY_API_', 'KEY=', '[REDACTED:keyed-secret]')],
  ['API_KEY = 32 hex', j('API_', 'KEY = ', 'a1b2c3d4e5f6a7b8', 'c9d0e1f2a3b4c5d6'), j('API_', 'KEY = ', '[REDACTED:keyed-secret]')],
  ['SLACK_SIGNING_SECRET env', j('SLACK_SIGNING_', 'SECRET=', 'a1b2c3d4e5f6a7b8', 'c9d0e1f2a3b4c5d6'), j('SLACK_SIGNING_', 'SECRET=', '[REDACTED:keyed-secret]')],
  ['NEXTAUTH_SECRET env', j('NEXTAUTH_', 'SECRET=', 'Q7vXk2Lm9PzR', '4tWy8NbC3dFh6JsA1eGu'), j('NEXTAUTH_', 'SECRET=', '[REDACTED:keyed-secret]')],
  ['GOOGLE_CLIENT_SECRET env', j('GOOGLE_CLIENT_', 'SECRET=', 'Q7vXk2Lm9PzR', '4tWy8NbC3dFh6JsA1eGu'), j('GOOGLE_CLIENT_', 'SECRET=', '[REDACTED:keyed-secret]')],
  ['client_secret= value', j('client_', 'secret=', 'Q7vXk2Lm9PzR', '4tWy8NbC3dFh6JsA1eGu'), j('client_', 'secret=', '[REDACTED:keyed-secret]')],
  ['client_secret= 64 hex', j('client_', 'secret=', '9f86d081884c7d659a2feaa0c55ad015', 'a3bf4f1b2b0b822cd15d6c15b0f00a08'), j('client_', 'secret=', '[REDACTED:keyed-secret]')],
  ['api_key: value', j('api_', 'key: ', 'Q7vXk2Lm9PzR', '4tWy8NbC3dFh6JsA1eGu'), j('api_', 'key: ', '[REDACTED:keyed-secret]')],
  ['JWT_SECRET, base64 with / and +', j('JWT_', 'SECRET=', 'Q7vXk2Lm9PzR/4tWy8NbC3dFh6JsA1eGu+FAKEfake0123/FAKE='), j('JWT_', 'SECRET=', '[REDACTED:keyed-secret]')],
  ['AWS_SESSION_TOKEN env, whole token', j('AWS_SESSION_', 'TOKEN=', j('IQoJb3JpZ2luX2VjEFAKEaCXVzLWVhc3QtMSJHMEUCIQ', '/FAKEfakeFAKEfake0123456789+FAKEfakeFAKEfake', '/FAKEfakeFAKEfake0123456789+FAKEfakeFAKEfake', '/FAKEfakeFAKEfake0123456789==')), j('AWS_SESSION_', 'TOKEN=', '[REDACTED:keyed-secret]')],
  ['aws_session_token in ~/.aws/credentials', j('aws_session_', 'token = ', j('IQoJb3JpZ2luX2VjEFAKEaCXVzLWVhc3QtMSJHMEUCIQ', '/FAKEfakeFAKEfake0123456789+FAKEfakeFAKEfake', '/FAKEfakeFAKEfake0123456789+FAKEfakeFAKEfake', '/FAKEfakeFAKEfake0123456789==')), j('aws_session_', 'token = ', '[REDACTED:keyed-secret]')],
  ['aws_session_token, shorter token', j('aws_session_', 'token = ', 'IQoJb3JpZ2luX2VjEFAKE', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE/FAKE+FAKE=='), j('aws_session_', 'token = ', '[REDACTED:keyed-secret]')],
  ['aws_secret_access_key = value', j('aws_secret_access_', 'key = ', 'wJalrXUtnFEMI/K7MDENG', '/bPxRfiCYFAKEKEY1'), j('aws_secret_access_', 'key = ', '[REDACTED:keyed-secret]')],
  ['AWS_SECRET_ACCESS_KEY=value', j('AWS_SECRET_ACCESS_', 'KEY=', 'wJalrXUtnFEMI/K7MDENG', '/bPxRfiCYFAKEKEY1'), j('AWS_SECRET_ACCESS_', 'KEY=', '[REDACTED:keyed-secret]')],
  ['npm legacy _auth=', j('_au', 'th=', Buffer.from(j('demo:', 'fakepw'), 'utf8').toString('base64')), j('_au', 'th=', '[REDACTED:keyed-secret]')],
  ['.npmrc registry _auth=', j('//registry.npmjs.org/:_au', 'th=', Buffer.from(j('demo:', 'fakepw'), 'utf8').toString('base64')), j('//registry.npmjs.org/:_au', 'th=', '[REDACTED:keyed-secret]')],
  ['.npmrc _authToken as a uuid', j('//registry.npmjs.org/:_auth', 'Token=', '00000000-0000-4000-8000-', '000000000000'), j('//registry.npmjs.org/:_auth', 'Token=', '[REDACTED:keyed-secret]')],
  ['Norwegian label hemmelighet=', j('hemmelig', 'het=', 'FakeHemmelig2026'), j('hemmelig', 'het=', '[REDACTED:keyed-secret]')],
  ['Norwegian label api-nøkkel:', j('api-nøk', 'kel: ', 'FAKEfakeFAKEfake', '0123456789abcdef'), j('api-nøk', 'kel: ', '[REDACTED:keyed-secret]')],
  ['a Cyrillic а in the label', j('pаss', 'word: ', 'FakePw2026'), j('pаss', 'word: ', '[REDACTED:keyed-secret]')],
  ['ordinary: env reference ${DB_PASSWORD}', j('pass', 'word=${DB_PASSWORD}'), SAME],
  ['ordinary: shell variable as the value', j('DB_PASS', 'WORD=$DB_PASSWORD_FROM_VAULT'), SAME],
  ['ordinary: pass key=value pairs', 'pass key=value pairs to the CLI, e.g. key=value', SAME],
  ['ordinary: max_tokens: 4096', 'max_tokens: 4096', SAME],
  ['ordinary: a three-letter value after token:', 'token: abc', SAME],
  ['ordinary: the token count', 'the token count is 1200 per request', SAME],
  ['ordinary: we use a token bucket', 'we use a token bucket for rate limits', SAME],
  ['ordinary: rate limit token bucket', 'rate limit uses a token bucket of 60 per minute', SAME],
  ['ordinary: secret santa', 'secret santa is on friday', SAME],
  ['ordinary: the password reset token expires', 'the password reset token expires in 1 hour', SAME],
  ['ordinary: set the secret: in the vault UI', 'set the secret: in the vault UI', SAME],
  ['ordinary: the password is in the vault', 'the password is in the vault', SAME],
  ['ordinary: CSS class with password', '.password-field { border: 1px solid red; }', SAME],
  ['ordinary: CSS attribute selector type=password', 'input[type=password] { color: red }', SAME],
  ['ordinary: PASSWORD_MIN_LENGTH', j('PASS', 'WORD_MIN_LENGTH=12'), SAME],
  ['ordinary: SECRET_NAME', 'SECRET_NAME=prod-db', SAME],
  ['ordinary: TOKEN_ENDPOINT URL', 'TOKEN_ENDPOINT=https://auth.example.test/oauth/token', SAME],
  ['ordinary: a sentence with no secret', 'Refactored the ingest queue; 3 files touched; ran bun test apps/ingest (42 pass).', SAME],

  // ---------------------------------------------------------------- by key: JSON, escaped JSON
  ['JSON token and password', j('{"tok', 'en": "', 'FAKEfakeFAKEfake0123456789_-FAKEfake', '", "pass', 'word":"', 'Qa5Sd4Fg3Hj2FAKEfake', '"}'), j('{"tok', 'en": "', '[REDACTED:keyed-secret]', '", "pass', 'word":"', '[REDACTED:keyed-secret]', '"}')],
  ['JSON password', j('"pass', 'word": "', 'Sommer2026!', '"'), j('"pass', 'word": "', '[REDACTED:keyed-secret]', '"')],
  ['aws-cli SecretAccessKey JSON', j('"SecretAccess', 'Key": "', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKEKEY1', '"'), j('"SecretAccess', 'Key": "', '[REDACTED:keyed-secret]', '"')],
  ['aws sts SessionToken JSON', j('"Session', 'Token": "', j('IQoJb3JpZ2luX2VjEFAKEaCXVzLWVhc3QtMSJHMEUCIQ', '/FAKEfakeFAKEfake0123456789+FAKEfakeFAKEfake', '/FAKEfakeFAKEfake0123456789+FAKEfakeFAKEfake', '/FAKEfakeFAKEfake0123456789=='), '"'), j('"Session', 'Token": "', '[REDACTED:keyed-secret]', '"')],
  ['curl -d with shell-escaped JSON', j('curl -X POST -H "Content-Type: application/json" -d "{\\"username\\":\\"demo\\",\\"pass', 'word\\":\\"FakePw2026\\"}" https://api.example.test/login'), j('curl -X POST -H "Content-Type: application/json" -d "{\\"username\\":\\"demo\\",\\"pass', 'word\\":\\"', '[REDACTED:keyed-secret]', '\\"}" https://api.example.test/login')],
  ['JSON inside a JSON string (a log line)', j('{"log":"{\\"pass', 'word\\": \\"FakePw2026\\"}"}'), j('{"log":"{\\"pass', 'word\\": \\"', '[REDACTED:keyed-secret]', '\\"}"}')],
  ['escaped JSON api_key, 32 chars', j('{\\"api_', 'key\\":\\"', 'FAKEfakeFAKEfake', '0123456789abcdef', '\\"}'), j('{\\"api_', 'key\\":\\"', '[REDACTED:keyed-secret]', '\\"}')],
  ['escaped JSON password, short', j('{\\"pass', 'word\\":\\"', 'hunter', '2x', '\\"}'), j('{\\"pass', 'word\\":\\"', '[REDACTED:keyed-secret]', '\\"}')],
  ['twice-escaped JSON password', j('{\\\\\\"pass', 'word\\\\\\":\\\\\\"', 'FakePw2026', '\\\\\\"}'), j('{\\\\\\"pass', 'word\\\\\\":\\\\\\"', '[REDACTED:keyed-secret]', '\\\\\\"}')],
  ['a JSON password with an escaped quote in it', j('{"pass', 'word":"FakePw\\"2026\\"tail"}'), j('{"pass', 'word":"', '[REDACTED:keyed-secret]', '"}')],
  ['refresh_token with a dot', j('"refresh_', 'token": "', 'FAKEfakeFAKEfake', '0123456789abcdef', 'FAKE.fakeTAILfake"'), j('"refresh_', 'token": "', '[REDACTED:keyed-secret]', '"')],
  ['ordinary: i18n label in English', j('"pass', 'word": "Password",'), SAME],
  ['ordinary: i18n label in Norwegian', j('"login.pass', 'word": "Passord",'), SAME],
  ['ordinary: validation message', j('errors: { pass', 'word: "is required" }'), SAME],
  ['ordinary: validation message in Norwegian', j('pass', 'word: "Passordet må ha minst 8 tegn"'), SAME],
  ['ordinary: "N/A"', j('pass', 'word: "N/A"'), SAME],
  ['ordinary: "*"', j('pass', 'word: "*"'), SAME],
  ['ordinary: a single space', j('pass', "word: ' ',"), SAME],
  ['ordinary: the your-password-here placeholder', j('set pass', "word: 'your-pass", "word-here'"), SAME],
  ['ordinary: JSON null', j('{"pass', 'word": null}'), SAME],
  ['ordinary: JSON tokenEndpoint URL', '{"tokenEndpoint": "https://auth.example.test/t"}', SAME],
  ['ordinary: JSON token counts', '{"input_tokens": 1200, "output_tokens": 300}', SAME],
  ['ordinary: JSON secret flag', '{"secret": true}', SAME],

  // ---------------------------------------------------------------- by key: YAML values and code
  ['yaml password: value', j('pass', 'word: ', 'FakeYamlPw2026'), j('pass', 'word: ', '[REDACTED:keyed-secret]')],
  ['yaml list item password: value', j('  - pass', 'word: ', 'FakeListPw2026'), j('  - pass', 'word: ', '[REDACTED:keyed-secret]')],
  ['one-character quoted password', j('pass', "word: 'x'"), j('pass', "word: '", '[REDACTED:keyed-secret]', "'")],
  ['password = "a b c"', j('pass', 'word = "a b c"'), j('pass', 'word = "', '[REDACTED:keyed-secret]', '"')],
  ['passphrase quoted with spaces', j('pass', 'phrase: "', 'correct horse battery staple', '"'), j('pass', 'phrase: "', '[REDACTED:keyed-secret]', '"')],
  ['passphrase after a note label', j('Deploy note: pass', 'phrase: "', 'correct horse battery staple', '"'), j('Deploy note: pass', 'phrase: "', '[REDACTED:keyed-secret]', '"')],
  ['X-API-Key header, 20 chars', j('X-API-', 'Key: ', 'FAKEfake', 'FAKEfake', '0123'), j('X-API-', 'Key: ', '[REDACTED:keyed-secret]')],
  ['x-auth-token header', j('x-auth-', 'token: ', 'FAKEfake0123456789'), j('x-auth-', 'token: ', '[REDACTED:keyed-secret]')],
  ['ordinary: TS type password: string', j('type Login = { pass', 'word: string; remember: boolean }'), SAME],
  ['ordinary: TS interface in a code fence', j('```ts\ninterface Login { pass', 'word: string }\n```'), SAME],
  ['ordinary: markdown table type', j('| pass', 'word | `string` | required |'), SAME],
  ['ordinary: placeholder <your password>', j('set pass', 'word: <your pass', 'word> in the form'), SAME],
  ['ordinary: Python Optional[str]', j('def login(user: str, pass', 'word: Optional[str] = None):'), SAME],
  ['ordinary: os.getenv call', j('pass', 'word = os.getenv("DB_PASS")'), SAME],
  ['ordinary: JS req.body field', j('const pass', 'word = req.body.pass', 'word;'), SAME],
  ['ordinary: input element value', j('pass', 'word: pass', 'wordInput.value'), SAME],
  ['ordinary: JS object, identifier value', j('pass', 'word: hashedPass', 'word,'), SAME],
  ['ordinary: JS object shorthand neighbours', j('{ user, pass', 'word: pass', 'word, remember }'), SAME],
  ['ordinary: JS await', j('pass', 'word: await bcrypt.hash(pass', 'word, 10),'), SAME],
  ['ordinary: Rust struct field', j('pass', 'word: Option<String>,'), SAME],
  ['ordinary: X-Request-Id header', 'X-Request-Id: 123e4567-e89b-12d3-a456-426614174000', SAME],
  ['ordinary: prose, forgot password: contact IT', j('Forgot pass', 'word: contact IT'), SAME],
  ['ordinary: prose, reset password: click the link', j('Reset pass', 'word: click the link in the e-mail'), SAME],
  ['ordinary: Norwegian prose, glemt passord: kontakt IT', 'Glemt passord: kontakt IT', SAME],
  ['ordinary: Norwegian prose, kontakt IT-avdelingen', 'Glemt passord: kontakt IT-avdelingen', SAME],
  ['ordinary: Norwegian prose, endre passord', 'Endre passord: Innstillinger > Sikkerhet', SAME],
  ['ordinary: Norwegian prose, nytt passord', 'Nytt passord: velg et som er langt', SAME],
  ['ordinary: the key: value pair', 'the key: value pair is stored in node_state', SAME],
  ['ordinary: the key: value pair is stored', 'the key: value pair is stored', SAME],

  // ---------------------------------------------------------------- by key: URL query and connection strings
  ['URL query token, percent-encoded base64', j('https://api.example.test/x?', 'token=', 'RkFLRWZha2VG', '%2BQUtFZmFrZTAx%2FMjM0NTY3ODk%3D'), j('https://api.example.test/x?', 'token=', '[REDACTED:keyed-secret]')],
  ['Azure SAS sig=', j('https://acct.blob.core.windows.net/c/f?sv=2022-11-02&sp=r&si', 'g=', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1Xa9B%3D'), j('https://acct.blob.core.windows.net/c/f?sv=2022-11-02&sp=r&si', 'g=', '[REDACTED:keyed-secret]')],
  ['Azure SAS sig= with an expiry', j('https://acct.blob.core.windows.net/c/f?sv=2022-11-02&se=2026-12-01&sp=r&si', 'g=', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1Xa9Bc2Df5G%3D'), j('https://acct.blob.core.windows.net/c/f?sv=2022-11-02&se=2026-12-01&sp=r&si', 'g=', '[REDACTED:keyed-secret]')],
  ['Azure SharedAccessSignature connection value', j('SharedAccess', 'Signature=sv=2022-11-02&si', 'g=', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1Xa9Bc2Df5G%3D'), j('SharedAccess', 'Signature=', '[REDACTED:keyed-secret]', '&si', 'g=', '[REDACTED:keyed-secret]')],
  ['Azure AccountKey in a connection string', j('DefaultEndpointsProtocol=https;AccountName=demo;Account', 'Key=', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1Xa9Bc2==', ';EndpointSuffix=core.windows.net'), j('DefaultEndpointsProtocol=https;AccountName=demo;Account', 'Key=', '[REDACTED:keyed-secret]', ';EndpointSuffix=core.windows.net')],
  ['Azure AccountKey, a reviewer\'s exact input', j('DefaultEndpointsProtocol=https;AccountName=demo;Account', 'Key=', 'q8Zr3Lm2Pv7Rt8Yw3NbZ', 'c4Hj6Ks0Ue1Xa9Bc2==', ';EndpointSuffix=core.windows.net'), j('DefaultEndpointsProtocol=https;AccountName=demo;Account', 'Key=', '[REDACTED:keyed-secret]', ';EndpointSuffix=core.windows.net')],
  ['Azure AccountKey at the end', j('AccountName=demo;Account', 'Key=', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZ', 'c4Hj6Ks0Ue1Xa9Bc2=='), j('AccountName=demo;Account', 'Key=', '[REDACTED:keyed-secret]')],
  ['Azure AccountKey, long, after a note label', j('Deploy note: Account', 'Key=', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1Xa9Bc2Df5Gh7Jk1Mn3Pq5St7Vx9Zb2Cd4Ef6Gh8Ij0Kl2Mn4Op6Qr8St0Uv2Wx4Yz6Ab8Cd0Ef2Gh4=='), j('Deploy note: Account', 'Key=', '[REDACTED:keyed-secret]')],
  ['Azure service bus SharedAccessKey', j('Endpoint=sb://demo.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccess', 'Key=', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZ', 'c4Hj6Ks0Ue1Xa9Bc2=', ';EntityPath=q'), j('Endpoint=sb://demo.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccess', 'Key=', '[REDACTED:keyed-secret]', ';EntityPath=q')],
  ['ADO.NET Password=', j('Server=db;User Id=sa;Pass', 'word=', 'Hunter22x', ';'), j('Server=db;User Id=sa;Pass', 'word=', '[REDACTED:keyed-secret]', ';')],
  ['ADO.NET Password= with spaces', j('Server=db;User Id=sa;Pass', 'word=', 'Fake Pw 2026;'), j('Server=db;User Id=sa;Pass', 'word=', '[REDACTED:keyed-secret]', ';')],
  ['ADO.NET Password={...;...}', j('Server=db;User Id=sa;Pass', 'word=', '{Fake;Pw2026};'), j('Server=db;User Id=sa;Pass', 'word=', '[REDACTED:keyed-secret]', ';')],
  ['ordinary: a search URL', 'https://example.test/search?q=token&page=2', SAME],
  ['ordinary: Drive pageToken in a URL', j('https://www.googleapis.com/drive/v3/files?pageToken=', 'CiAKGjBpNDd2Nmp2Zml2', 'cXRwYjBpOXA0dHYwMBAB'), SAME],

  // ---------------------------------------------------------------- by key: ids, paths and cursors are not secrets
  ['ordinary: idempotency key uuid', 'idempotency key: 123e4567-e89b-12d3-a456-426614174000', SAME],
  ['ordinary: idempotency_key hex', 'idempotency_key: 123e4567e89b12d3a456426614174000', SAME],
  ['ordinary: partition_key', 'partition_key=tenant-123e4567-e89b-12d3-a456-426614174000', SAME],
  ['ordinary: primary_key sha', j('primary_key: ', '9f86d081884c7d659a2f', 'eaa0c55ad015a3bf4f1b'), SAME],
  ['ordinary: CI cache_key', j('cache_key=node-modules-', '9f86d081884c7d659a2f', 'eaa0c55ad015a3bf4f1b'), SAME],
  ['ordinary: next_page_token', j('next_page_token: ', 'CiAKGjBpNDd2Nmp2Zml2', 'cXRwYjBpOXA0dHYwMBAB'), SAME],
  ['ordinary: pageToken', j('pageToken: "', 'CiAKGjBpNDd2Nmp2Zml2', 'cXRwYjBpOXA0dHYwMBAB', '"'), SAME],
  ['ordinary: S3 object_key path', 'object_key: uploads/123e4567-e89b-12d3-a456-426614174000/report.pdf', SAME],
  ['ordinary: S3 thumbnail_key path', j('thumbnail_key: images/2026/10/', '9f86d081884c7d659a2feaa0c55ad015', 'a3bf4f1b2b0b822cd15d6c15b0f00a08', '.png'), SAME],
  ['ordinary: GCP Secret Manager resource name', j('secret: projects/demo/secrets/', '9f86d081884c7d659a2f', 'eaa0c55ad015a3bf4f1b'), SAME],
  ['ordinary: a path after a token label', 'token: /home/person/projects/wybe-connect/packages/claude-code/lib', SAME],
  ['ordinary: plain uuid', 'request 123e4567-e89b-12d3-a456-426614174000 failed', SAME],
  ['ordinary: session uuid', 'session 123e4567-e89b-12d3-a456-426614174000 started', SAME],
  ['ordinary: long hex sha', 'commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 landed', SAME],
  ['ordinary: git sha on main', 'commit 9fceb02d0ae598e95dc970b74767f19372d61af8 on main', SAME],

  // ---------------------------------------------------------------- entropy
  ['an unlabeled 44-character random string', j('the new key is ', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6', 'Ks0Ue1Xa9Bc2Df5Gh7'), 'the new key is [REDACTED:high-entropy]'],
  ['an unlabeled random string in a JSON note', j('{"note": "rotate ', 'FAKE7Hq2Zx9Lm4Pv8Rt3Yw6NbZc1', 'Hj5Ks0Ue2Xa7Bc', ' tonight"}'), '{"note": "rotate [REDACTED:high-entropy] tonight"}'],
  ['ordinary: ssh public key line', j('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI', 'FAKEfakeFAKEfake0123456789FAKEfakeFAKEfake01 demo@laptop'), SAME],
  ['ordinary: package-lock integrity', j('"integrity": "sha512-', 'FAKEq8Zr3Lm2Pv7Rt8Yw3NbZc4Hj6Ks0Ue1Xa9Bc2Df5Gh7Jk1Mn3Pq5St7Vx9Zb2Cd4Ef6Gh8Ij0Kl2Mn4Op6Qr8St0Uv2Wx4Yz6Ab8C=="'), SAME],
  ['ordinary: a long identifier', 'handleOAuth2CallbackForMicrosoftGraphV1EndpointAndRetry', SAME],
  ['ordinary: a tool use id', 'tool toolu_01FAKEq8Zr3Lm2Pv7Rt8Yw3Nb returned', SAME],

  // ---------------------------------------------------------------- personal data
  ['a valid fodselsnummer', j('fnr ', '150585', '45640'), 'fnr [REDACTED:fodselsnummer]'],
  ['a valid fodselsnummer with a space', j('spaced ', '150585', ' 45640'), 'spaced [REDACTED:fodselsnummer]'],
  ['an e-mail address', 'write to eier@example.invalid', 'write to [REDACTED:email]'],
  ['ordinary: an 11-digit order number', 'order 12345678901', SAME],
  ['ordinary: an 11-digit number whose control digits fail', j('wrong ', '150585', '45641'), SAME],
];

for (const [what, input, expected] of TABLE) {
  test(`table: ${what}`, () => {
    const want = expected === SAME ? input : expected;
    assert.equal(redact(input).text, want);
    assert.equal(redact(want).text, want, 'idempotent');
  });
}

test('table: every row has a distinct label and a distinct input', () => {
  assert.equal(new Set(TABLE.map((r) => r[0])).size, TABLE.length, 'labels');
  assert.equal(new Set(TABLE.map((r) => r[1])).size, TABLE.length, 'inputs');
});

// Mutation check: with one family switched off, at least one row must come out different. A
// family no row depends on is a family the table does not test. The null control (nothing off)
// must match every row.
const rowsChangedWith = (disable) => TABLE.filter(([, input, expected]) => redact(input, { disable }).text !== (expected === SAME ? input : expected)).map(([what]) => what);

test('table: null control, nothing switched off, every row holds', () => {
  assert.deepEqual(rowsChangedWith([]), []);
});

for (const family of FAMILIES) {
  test(`table: switching off ${family.name} turns at least one row red`, () => {
    assert.ok(rowsChangedWith([family.name]).length > 0, `no row depends on ${family.name}`);
  });
}
