/// <reference types="node" />
import type { Skill, SkillContext } from '@botforge/core';

interface PendingQuestion {
  question: string;
  timestamp: Date;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Pending Questions Skill — tracks when the bot asks a question
 * and injects it as context for the user's next message.
 * In-memory Map — lost on restart (acceptable for transient state).
 */
export class PendingQuestionsSkill implements Skill {
  readonly name = 'pending-questions';
  private enabled = false;
  private pending = new Map<string, PendingQuestion>();
  private cleanupInterval?: any;

  async init(ctx: SkillContext): Promise<void> {
    this.enabled = !!(ctx.config as any).behavior?.continuity?.pending_questions;
    if (this.enabled) {
      ctx.log.info('Pending questions tracking enabled (in-memory)');
      // Cleanup expired entries every 5 minutes
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
      this.cleanupInterval.unref();
    }
  }

  /** Record that the bot asked a question in this chat */
  recordQuestion(chatId: string, responseText: string): void {
    if (!this.enabled) return;
    // Check if the response ends with a question mark
    const trimmed = responseText.trim();
    if (trimmed.endsWith('?')) {
      // Extract the last sentence as the question
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      const lastQuestion = sentences.filter(s => s.trim().endsWith('?')).pop() ?? trimmed;
      this.pending.set(chatId, { question: lastQuestion, timestamp: new Date() });
    }
  }

  /** Get and clear pending question context block for a chat */
  getContextBlock(chatId: string): string {
    if (!this.enabled) return '';
    const entry = this.pending.get(chatId);
    if (!entry) return '';

    // Check TTL
    if (Date.now() - entry.timestamp.getTime() > TTL_MS) {
      this.pending.delete(chatId);
      return '';
    }

    // Clear on retrieval (the user is responding)
    this.pending.delete(chatId);
    return `<pending_question>${entry.question}</pending_question>`;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [chatId, entry] of this.pending) {
      if (now - entry.timestamp.getTime() > TTL_MS) {
        this.pending.delete(chatId);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.pending.clear();
  }
}

export function createSkill(): PendingQuestionsSkill {
  return new PendingQuestionsSkill();
}

export default new PendingQuestionsSkill();
