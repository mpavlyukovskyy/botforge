/**
 * Cron handler: weekly_review
 *
 * Generates and sends the weekly review summary. Friday at 5pm ET.
 */
import { generateWeeklyReview } from '../lib/briefing.js';

export default {
  name: 'weekly_review',
  async execute(ctx) {
    const chatId = ctx.config.platform?.chat_ids?.[0]
      || ctx.config.behavior?.access?.admin_users?.[0];
    if (!chatId) {
      ctx.log.warn('Weekly review: no admin chat ID configured');
      return;
    }

    try {
      const result = await generateWeeklyReview(ctx);
      const reviewText = typeof result === 'string' ? result : result.text;

      await ctx.adapter.send({
        chatId,
        text: reviewText,
        parseMode: 'Markdown',
      });

      ctx.log.info(`Weekly review sent${result.usage ? ` ($${result.usage.costUsd?.toFixed(4)})` : ''}`);
    } catch (err) {
      ctx.log.error(`Weekly review failed: ${err.message}`);

      await ctx.adapter.send({
        chatId,
        text: '⚠️ Weekly review generation failed. Check logs.',
      });
    }
  },
};
