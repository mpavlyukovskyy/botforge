import type { Skill, SkillContext } from '@botforge/core';

export type DigestBuilder = () => Promise<string>;

export class DailyDigestSkill implements Skill {
  readonly name = 'daily-digest';
  private digestBuilder?: DigestBuilder;
  private ctx?: SkillContext;

  async init(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;

    // Register with cron-scheduler if available
    const cronSkill = ctx.skills.get('cron-scheduler');
    if (cronSkill && 'registerHandler' in cronSkill) {
      (cronSkill as any).registerHandler('daily_digest', () => this.sendDigest());
      ctx.log.info('Daily digest handler registered with cron scheduler');
    }
  }

  /** Set the digest builder function — called by bot tools at init */
  setDigestBuilder(builder: DigestBuilder): void {
    this.digestBuilder = builder;
  }

  /** Generate and send the daily digest */
  async sendDigest(): Promise<void> {
    if (!this.ctx || !this.digestBuilder) {
      this.ctx?.log.warn('Daily digest: no builder registered, skipping');
      return;
    }

    try {
      const digestText = await this.digestBuilder();
      if (!digestText) {
        this.ctx.log.info('Daily digest: empty, skipping');
        return;
      }

      // Send to all configured chat IDs, or use platform default
      const platform = this.ctx.config.platform;
      if (platform.type === 'telegram' && platform.chat_ids?.length) {
        for (const chatId of platform.chat_ids) {
          await this.ctx.adapter.send({
            chatId,
            text: digestText,
            parseMode: 'Markdown',
          });
        }
      }

      this.ctx.log.info('Daily digest sent');
    } catch (err) {
      this.ctx.log.error(`Daily digest failed: ${err}`);
    }
  }
}

export function createSkill(): DailyDigestSkill {
  return new DailyDigestSkill();
}

export default new DailyDigestSkill();
