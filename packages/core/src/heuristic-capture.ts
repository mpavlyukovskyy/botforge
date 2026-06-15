/**
 * Deterministic, LLM-free heuristics for the fallback-capture path (brain down).
 *
 * Two jobs:
 *  - looksLikeTask(): an intent gate so we don't turn a question / acknowledgment
 *    / status query into a junk task. This matters because some bots (Kristina)
 *    write to a financial-incentive board — a spurious task is noise, so we err
 *    toward NOT capturing when the message clearly isn't an action item.
 *  - heuristicTaskTitle(): strip the bot @mention and produce a clean title.
 *
 * Pure, dependency-free, never throws.
 */

const ACK_WORDS = new Set([
  'ok', 'okay', 'k', 'kk', 'thanks', 'thank you', 'ty', 'yes', 'ya', 'yeah', 'yep',
  'yup', 'no', 'nope', 'nah', 'sure', 'got it', 'gotit', 'done', "it's done",
  'its done', 'this is done', 'cool', 'great', 'perfect', 'nice', '👍', 'ok thanks',
]);

const QUESTION_STARTS = [
  'what', 'whats', "what's", 'when', 'where', 'who', 'whom', 'why', 'how',
  'can you', 'could you', 'do you', 'does', 'did you', 'is there', 'are there',
  'should i', 'should we', 'will you', 'would you', 'how much', 'how many',
];

/** Strip a leading/inline @mention of the bot from the text. */
export function stripBotMention(text: string, botUsername?: string): string {
  let out = text;
  if (botUsername) {
    const esc = botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`@${esc}\\b`, 'gi'), ' ');
  } else {
    // Username unknown: strip a LEADING @token only — an addressed message's
    // first @mention is almost always the bot. A mid-sentence @assignee is kept.
    out = out.replace(/^\s*@[A-Za-z0-9_]+\b/, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Conservative intent gate: should a failed-brain message be captured as a task?
 * Returns false for empty/tiny input, acknowledgments, and questions/queries.
 */
export function looksLikeTask(text: string | undefined, botUsername?: string): boolean {
  if (!text) return false;
  const cleaned = stripBotMention(text, botUsername);
  if (cleaned.length < 3) return false;

  const lower = cleaned.toLowerCase();

  // Slash commands are not tasks.
  if (cleaned.startsWith('/')) return false;

  // Pure acknowledgments.
  const compact = lower.replace(/[.!,]+$/g, '').trim();
  if (ACK_WORDS.has(compact)) return false;

  // Questions / status queries.
  if (cleaned.endsWith('?')) return false;
  for (const q of QUESTION_STARTS) {
    if (lower === q || lower.startsWith(q + ' ')) return false;
  }

  // Needs at least two words to be a meaningful action item.
  if (cleaned.split(/\s+/).filter(Boolean).length < 2) return false;

  return true;
}

/** Produce a clean, length-clamped task title from raw message text. */
export function heuristicTaskTitle(text: string, botUsername?: string): string {
  let title = stripBotMention(text, botUsername) || text.trim();
  title = title.charAt(0).toUpperCase() + title.slice(1);
  if (title.length > 200) title = title.slice(0, 200).trimEnd() + '…';
  return title;
}
