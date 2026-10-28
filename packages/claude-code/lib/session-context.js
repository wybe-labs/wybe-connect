// What the SessionStart hook hands to Claude: the standing instruction plus the node's cached
// open questions (from the last tool response, stored by flush.js). No network here.

export const STANDING_INSTRUCTION = 'Before you finish, call the `wybe` MCP server\'s `remember` tool with any durable facts about this person\'s WORK you learned this session (projects, decisions, preferences, tools). Work only: nothing personal, nothing about other people, no secrets.';

export const MAX_QUESTIONS = 3;
export const MAX_QUESTION_CHARS = 300;
export const MAX_QUESTION_ID_CHARS = 64;

// Every C0/C1 control character (line breaks and tabs included) and the Unicode line and paragraph
// separators: node-supplied text must stay inside the one line it is quoted on.
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${SEPARATORS}]+`, 'g');

/**
 * An open question's text, cleaned: the node sends { id, question }; `text` is the older shape.
 * Control characters and line breaks become one space, and the text is capped, so a question can
 * never add a line of its own to Claude's context. Null when there is no text.
 */
export function questionText(q) {
  const raw = typeof q?.question === 'string' ? q.question : typeof q?.text === 'string' ? q.text : null;
  if (raw === null) return null;
  const clean = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > MAX_QUESTION_CHARS ? `${clean.slice(0, MAX_QUESTION_CHARS - 1)}…` : clean;
}

/** An open question's id, reduced to the characters an id needs, capped. Null when none is left. */
export function questionId(q) {
  if (typeof q?.id !== 'string') return null;
  const clean = q.id.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, MAX_QUESTION_ID_CHARS);
  return clean || null;
}

export function buildContext({ credentials, cached }) {
  if (!credentials) return null;
  const lines = [
    `You are connected to this person's Wybe colleague at ${credentials.nodeUrl} (granted scopes: ${credentials.scopes.join(', ')}).`,
    STANDING_INSTRUCTION,
  ];
  const questions = Array.isArray(cached?.open_questions) ? cached.open_questions.filter((q) => questionText(q) !== null) : [];
  if (questions.length) {
    lines.push('The colleague has open questions for this person. When it fits naturally, ask one and pass the answer to `remember` with `answers: [<question id>]`:');
    for (const q of questions.slice(0, MAX_QUESTIONS)) lines.push(`- (${questionId(q) ?? '?'}) ${questionText(q)}`);
  }
  return lines.join('\n');
}
