import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';

interface ConversationEntry {
  userText: string;
  assistantText: string;
  timestamp: number;
}

interface ChatHistory {
  turns: ConversationEntry[];
  lastActivity: number;
}

const MAX_TURNS = 10;
const EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours

const histories = new Map<string, ChatHistory>();

function evictStale(): void {
  const now = Date.now();
  for (const [chatId, history] of histories) {
    if (now - history.lastActivity > EXPIRY_MS) {
      histories.delete(chatId);
    }
  }
}

function getOrCreate(chatId: string): ChatHistory {
  evictStale();
  let h = histories.get(chatId);
  if (!h) {
    h = { turns: [], lastActivity: Date.now() };
    histories.set(chatId, h);
  }
  return h;
}

export function addTurn(chatId: string, userText: string, assistantText: string): void {
  if (!userText?.trim() || !assistantText?.trim()) return;
  const h = getOrCreate(chatId);
  h.turns.push({ userText, assistantText, timestamp: Date.now() });
  if (h.turns.length > MAX_TURNS) {
    h.turns = h.turns.slice(-MAX_TURNS);
  }
  h.lastActivity = Date.now();
  persistTurn(chatId, userText, assistantText);
}

export function buildMessagesArray(
  chatId: string,
  context: string,
  userText: string,
  userName?: string,
): Anthropic.MessageParam[] {
  const h = histories.get(chatId);
  const messages: Anthropic.MessageParam[] = [];

  if (h && h.turns.length > 0) {
    if (Date.now() - h.lastActivity > EXPIRY_MS) {
      histories.delete(chatId);
    } else {
      for (const turn of h.turns) {
        if (turn.userText?.trim() && turn.assistantText?.trim()) {
          messages.push({ role: 'user', content: turn.userText });
          messages.push({ role: 'assistant', content: turn.assistantText });
        }
      }
    }
  }

  const speaker = userName || 'User';
  const currentMessage = `${context}\n\n${speaker} says: ${userText}`;
  messages.push({ role: 'user', content: currentMessage });

  return sanitizeMessages(messages);
}

export function clearHistory(chatId: string): void {
  histories.delete(chatId);
}

function sanitizeMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  while (messages.length > 0 && messages[0].role !== 'user') {
    messages.shift();
  }

  if (messages.length === 0) return messages;

  const merged: Anthropic.MessageParam[] = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];
    if (prev.role === curr.role) {
      const prevText = typeof prev.content === 'string' ? prev.content : '';
      const currText = typeof curr.content === 'string' ? curr.content : '';
      merged[merged.length - 1] = { role: prev.role, content: `${prevText}\n\n${currText}` };
    } else {
      merged.push(curr);
    }
  }

  return merged.filter(m => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return content?.trim().length > 0;
  });
}

function persistTurn(chatId: string, userText: string, assistantText: string): void {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO conversation_history (chat_id, role, content_text)
      VALUES (?, ?, ?)
    `);
    stmt.run(chatId, 'user', userText.substring(0, 4000));
    stmt.run(chatId, 'assistant', assistantText.substring(0, 4000));
  } catch (err) {
    console.warn('[conversation] Failed to persist turn:', err);
  }
}

export function loadConversationSummary(chatId: string, maxTurns: number = 20): string {
  try {
    const db = getDb();
    const config = getConfig();
    const botName = config.BOT_NAME;

    const rows = db.prepare(`
      SELECT role, content_text, created_at
      FROM conversation_history
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(chatId, maxTurns * 2) as Array<{ role: string; content_text: string; created_at: string }>;

    if (rows.length === 0) return '';

    rows.reverse();

    let summary = '';
    const MAX_CHARS = 8000;

    for (const row of rows) {
      const label = row.role === 'user' ? 'User' : botName;
      const line = `[${row.created_at}] ${label}: ${row.content_text}\n`;
      if (summary.length + line.length > MAX_CHARS) break;
      summary += line;
    }

    if (!summary) return '';

    return `<recent_conversation_history>
The following is your recent conversation history (loaded from persistent storage after a restart or idle period). Use this to maintain continuity:

${summary.trim()}
</recent_conversation_history>\n`;
  } catch (err) {
    console.warn('[conversation] Failed to load summary:', err);
    return '';
  }
}

export function hasActiveHistory(chatId: string): boolean {
  const h = histories.get(chatId);
  if (!h || h.turns.length === 0) return false;
  return (Date.now() - h.lastActivity) <= EXPIRY_MS;
}

export function cleanupOldConversations(): void {
  try {
    const db = getDb();
    const result = db.prepare("DELETE FROM conversation_history WHERE created_at < datetime('now', '-30 days')").run();
    if (result.changes > 0) {
      console.log(`[conversation] Cleaned up ${result.changes} old entries`);
    }
  } catch (err) {
    console.warn('[conversation] Failed to cleanup:', err);
  }
}
