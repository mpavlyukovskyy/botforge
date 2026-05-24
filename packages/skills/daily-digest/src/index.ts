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

  /**
   * Build a framework-side health digest covering: today's Anthropic spend
   * (vs cap if set), DLQ pending count, inbox + outbox status counts. Bots
   * that haven't registered a custom builder get this by default.
   */
  buildFrameworkDigest(): string {
    if (!this.ctx) return '';
    const lines: string[] = [];
    lines.push(`*🤖 ${this.ctx.config.name} — daily digest*`);

    // Anthropic spend
    const tokenTracker = this.ctx.skills.get('token-tracker');
    if (tokenTracker && 'getDailySpend' in tokenTracker) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spent = (tokenTracker as any).getDailySpend() as number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cap = (this.ctx.config.brain as any).budget_usd_per_day as number | undefined;
      if (cap) {
        const pct = Math.round((spent / cap) * 100);
        lines.push(`💰 Anthropic: $${spent.toFixed(4)} / $${cap.toFixed(2)} (${pct}%)`);
      } else {
        lines.push(`💰 Anthropic: $${spent.toFixed(4)} (no cap)`);
      }
    }

    // Inbox stats
    const inbox = this.ctx.skills.get('telegram-inbox');
    if (inbox && 'inboxStats' in inbox) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = (inbox as any).inboxStats() as Record<string, number>;
      lines.push(`📥 Inbox: ${s.done} done · ${s.processing} in flight · ${s.failed} failed · ${s.received} received`);
    }

    // Outbox stats
    const outbox = this.ctx.skills.get('telegram-outbox');
    if (outbox && 'stats' in outbox) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = (outbox as any).stats() as Record<string, number>;
      lines.push(`📤 Outbox: ${s.sent} sent · ${s.pending} pending · ${s.failed} failed`);
    }

    // DLQ count
    const dlq = this.ctx.skills.get('dlq');
    if (dlq && 'pendingCount' in dlq) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = (dlq as any).pendingCount() as number;
      lines.push(`☠️ DLQ pending: ${n}`);
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }

  /** Generate and send the daily digest */
  async sendDigest(): Promise<void> {
    if (!this.ctx) return;

    try {
      // Custom builder takes precedence; framework digest is the default.
      const digestText = this.digestBuilder
        ? await this.digestBuilder()
        : this.buildFrameworkDigest();
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
