import type { Skill, SkillContext } from '@botforge/core';
import { SqliteStorage, ConversationHistoryStore, CONVERSATION_HISTORY_MIGRATIONS } from '@botforge/storage-sqlite';

export class ConversationHistorySkill implements Skill {
  readonly name = 'conversation-history';
  private store?: ConversationHistoryStore;
  private storage?: SqliteStorage;

  async init(ctx: SkillContext): Promise<void> {
    const histConfig = ctx.config.memory?.conversation_history;
    if (!histConfig?.enabled) return;

    // Create storage using bot name for database path
    const dbPath = `data/${ctx.config.name}.db`;
    this.storage = new SqliteStorage({
      path: dbPath,
      migrations: CONVERSATION_HISTORY_MIGRATIONS,
      log: ctx.log,
    });

    this.store = new ConversationHistoryStore(this.storage, {
      maxMessages: histConfig.max_messages,
      ttlDays: histConfig.ttl_days,
      stripActionLines: histConfig.strip_action_lines,
      sessionTimeoutMinutes: (histConfig as any).session_timeout_minutes,
    });

    ctx.log.info(`Conversation history initialized (TTL: ${histConfig.ttl_days}d, max: ${histConfig.max_messages})`);
  }

  async addMessage(chatId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    this.store?.add(chatId, role, content);
  }

  async formatHistory(chatId: string): Promise<string> {
    return this.store?.formatAsContextBlock(chatId) ?? '';
  }

  async cleanup(): Promise<number> {
    return this.store?.cleanup() ?? 0;
  }

  getLastMessageTime(chatId: string): Date | null {
    return this.store?.getLastMessageTime(chatId) ?? null;
  }

  getRecentChatIds(withinMinutes: number): string[] {
    return this.store?.getRecentChatIds(withinMinutes) ?? [];
  }

  async destroy(): Promise<void> {
    this.storage?.close();
  }
}

export function createSkill(): ConversationHistorySkill {
  return new ConversationHistorySkill();
}

export default new ConversationHistorySkill();
