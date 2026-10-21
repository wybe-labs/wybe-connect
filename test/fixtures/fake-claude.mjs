// Stands in for `claude` in the tests: records how it was started (argv and the distil marker) in
// $FAKE_CLAUDE_LOG, one JSON line per start, and exits. The tests never start the real claude.
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv: process.argv.slice(2), distil: process.env.WYBE_CONNECT_DISTIL ?? null, cwd: process.cwd() })}\n`);
}

// A healthy run reaches the node: the recorder writes what the plugin's server would, one
// acknowledged pending_questions call, so the watchdog's ledger verdict sees a delivered run.
if (process.env.WYBE_CONNECT_LEDGER) {
  appendFileSync(process.env.WYBE_CONNECT_LEDGER, `${JSON.stringify({ tool: 'pending_questions', ok: true, importOf: null, importDone: false })}\n`);
}
