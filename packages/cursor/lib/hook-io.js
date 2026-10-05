// Hook process I/O shared by every harness. Claude Code, Codex and Cursor all pipe one JSON object
// on stdin; when a person runs a hook script by hand on a terminal there is nothing to read, so a
// TTY stdin yields {}.

export async function readHookInput() {
  if (process.stdin.isTTY) return {};
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

/** One line on stderr, exit 0. The hook must never block the session, and the line never carries a secret. */
export function failOpen(what, err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`wybe-connect: ${what} failed: ${message.split('\n')[0].slice(0, 300)}\n`);
  process.exitCode = 0;
}

/** The one stderr line a flush may print: only when something is waiting in the local queue. */
export function queueNotice(summary) {
  if (summary.queued > 0 || (summary.queue && summary.queue.count > 0)) {
    return `wybe-connect: node not reachable (${summary.lastOutcome?.kind ?? 'unknown'}); ${summary.queue.count} delta(s) queued locally\n`;
  }
  return '';
}
