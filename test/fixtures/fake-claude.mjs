// Stands in for `claude` in the tests: records how it was started (argv and the distil marker) in
// $FAKE_CLAUDE_LOG, one JSON line per start, and exits. The tests never start the real claude.
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv: process.argv.slice(2), distil: process.env.WYBE_CONNECT_DISTIL ?? null, cwd: process.cwd() })}\n`);
}
