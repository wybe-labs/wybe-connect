// What the SessionStart hook hands to Claude: the standing instruction plus the node's cached
// open questions (from the last tool response, stored by flush.js). No network here.

export const STANDING_INSTRUCTION = 'Before you finish, call the `wybe` MCP server\'s `remember` tool with any durable facts about this person\'s WORK you learned this session (projects, decisions, preferences, tools). Work only: nothing personal, nothing about other people, no secrets.';

export const MAX_QUESTIONS = 3;

export function buildContext({ credentials, cached }) {
  if (!credentials) return null;
  const lines = [
    `You are connected to this person's Wybe colleague at ${credentials.nodeUrl} (granted scopes: ${credentials.scopes.join(', ')}).`,
    STANDING_INSTRUCTION,
  ];
  const questions = Array.isArray(cached?.open_questions) ? cached.open_questions.filter((q) => q && typeof q.text === 'string') : [];
  if (questions.length) {
    lines.push('The colleague has open questions for this person. When it fits naturally, ask one and pass the answer to `remember` with `answers: [<question id>]`:');
    for (const q of questions.slice(0, MAX_QUESTIONS)) lines.push(`- (${q.id ?? '?'}) ${q.text}`);
  }
  return lines.join('\n');
}
