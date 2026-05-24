/**
 * Reception — pure decision: should this incoming message be processed by
 * the brain, or dropped silently?
 *
 * Extracted from runtime.ts during T1.4. No logging, no side effects — the
 * caller in runtime.ts handles those. Returning a structured reason makes
 * the drop path debuggable in tests.
 */

import type { IncomingMessage } from './adapter.js';
import type { Reception } from './schema.js';

export type ReceptionDecision =
  | { process: true }
  | { process: false; reason: string };

export interface ReceptionContext {
  /** Bot's own user_id (Telegram), if known — used for reply-to-bot detection. */
  botId?: string;
  /** Bot's username without @, if known — used for @mention matching. */
  botUsername?: string;
}

const PROCESS: ReceptionDecision = { process: true };

/**
 * Decide whether a message should be processed by the bot's brain or dropped.
 *
 * Order of checks (preserved from inlined logic in runtime.ts):
 *   1. Group messages: group_mode (ignore | passive | always)
 *      - passive: require @mention, reply-to-this-bot, or keyword/pattern match
 *   2. DM messages: dm_mode (ignore | keyword_only | always)
 *      - keyword_only: require at least one keyword match
 *   3. Default = process.
 */
export function shouldProcessMessage(
  message: IncomingMessage,
  receptionCfg: Reception | undefined,
  ctx: ReceptionContext,
): ReceptionDecision {
  if (message.isGroup) {
    return decideGroup(message, receptionCfg, ctx);
  }
  return decideDirect(message, receptionCfg);
}

function decideGroup(
  message: IncomingMessage,
  receptionCfg: Reception | undefined,
  ctx: ReceptionContext,
): ReceptionDecision {
  const groupMode = receptionCfg?.group_mode ?? 'always';

  if (groupMode === 'ignore') return { process: false, reason: 'group_mode=ignore' };

  if (groupMode !== 'passive') return PROCESS;

  // passive mode — require an explicit trigger.

  // Reply to THIS bot (not any bot).
  if (
    receptionCfg?.respond_to_replies !== false &&
    message.replyToUserId &&
    ctx.botId &&
    message.replyToUserId === ctx.botId
  ) {
    return PROCESS;
  }

  // @mention with word boundary.
  if (receptionCfg?.respond_to_mentions !== false && ctx.botUsername) {
    const mentionRegex = new RegExp(`@${ctx.botUsername}\\b`, 'i');
    if (message.text && mentionRegex.test(message.text)) return PROCESS;
  }

  // Keyword/pattern matching.
  if (message.text) {
    if (keywordOrPatternMatches(message.text, receptionCfg)) return PROCESS;
  }

  return { process: false, reason: 'group_mode=passive, no trigger matched' };
}

function decideDirect(
  message: IncomingMessage,
  receptionCfg: Reception | undefined,
): ReceptionDecision {
  const dmMode = receptionCfg?.dm_mode ?? 'always';
  if (dmMode === 'ignore') return { process: false, reason: 'dm_mode=ignore' };
  if (dmMode === 'keyword_only') {
    if (!message.text) return { process: false, reason: 'dm_mode=keyword_only, no text' };
    if (!keywordMatches(message.text, receptionCfg)) {
      return { process: false, reason: 'dm_mode=keyword_only, no keyword matched' };
    }
  }
  return PROCESS;
}

/** Keyword-only check (no patterns). Used by DM keyword_only mode. */
function keywordMatches(text: string, receptionCfg: Reception | undefined): boolean {
  const keywords = receptionCfg?.keywords ?? [];
  if (keywords.length === 0) return false;
  const caseSensitive = receptionCfg?.case_sensitive ?? false;
  const compareText = caseSensitive ? text : text.toLowerCase();
  for (const kw of keywords) {
    if (compareText.includes(caseSensitive ? kw : kw.toLowerCase())) return true;
  }
  return false;
}

/** Keyword OR regex pattern match. Used by group passive mode. */
function keywordOrPatternMatches(text: string, receptionCfg: Reception | undefined): boolean {
  if (keywordMatches(text, receptionCfg)) return true;
  const patterns = receptionCfg?.patterns ?? [];
  const caseSensitive = receptionCfg?.case_sensitive ?? false;
  for (const p of patterns) {
    try {
      if (new RegExp(p, caseSensitive ? '' : 'i').test(text)) return true;
    } catch {
      // Invalid regex in YAML — skip (don't crash the whole handler).
    }
  }
  return false;
}
