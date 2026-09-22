// Reads the hook's stdin JSON. Claude Code always pipes one JSON object; when a person runs the
// script by hand on a terminal there is nothing to read, so a TTY stdin yields {}.

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
