import type { Skill, SkillContext, IncomingMessage } from '@botforge/core';

/**
 * Reply Context Skill — injects the replied-to message text into brain context.
 * Enabled via behavior.continuity.reply_context: true.
 */
export class ReplyContextSkill implements Skill {
  readonly name = 'reply-context';
  private enabled = false;

  async init(ctx: SkillContext): Promise<void> {
    this.enabled = !!(ctx.config as any).behavior?.continuity?.reply_context;
    if (this.enabled) {
      ctx.log.info('Reply context injection enabled');
    }
  }

  /**
   * Returns a context block string if the message is a reply and has reply text.
   * Returns empty string if not applicable.
   */
  getContextBlock(message: IncomingMessage): string {
    if (!this.enabled) return '';
    if (!message.replyToText) return '';
    return `<replied_to_message>${message.replyToText}</replied_to_message>`;
  }
}

export function createSkill(): ReplyContextSkill {
  return new ReplyContextSkill();
}

export default new ReplyContextSkill();
