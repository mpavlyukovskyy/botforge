/**
 * Cron handler: morning_briefing
 *
 * Generates and sends the daily morning briefing. Weekdays at 8:30am ET.
 */
import { generateMorningBriefing } from '../lib/briefing.js';

export default {
  name: 'morning_briefing',
  async execute(ctx) {
    const chatId = ctx.config.platform?.chat_ids?.[0]
      || ctx.config.behavior?.access?.admin_users?.[0];
    if (!chatId) {
      ctx.log.warn('Morning briefing: no admin chat ID configured');
      return;
    }

    try {
      const result = await generateMorningBriefing(ctx);
      const briefingText = typeof result === 'string' ? result : result.text;

      await ctx.adapter.send({
        chatId,
        text: briefingText,
        parseMode: 'Markdown',
      });

      ctx.log.info(`Morning briefing sent${result.usage ? ` ($${result.usage.costUsd?.toFixed(4)})` : ''}`);
    } catch (err) {
      ctx.log.error(`Morning briefing failed: ${err.message}`);

      await ctx.adapter.send({
        chatId,
        text: '⚠️ Morning briefing generation failed. Check logs.',
      });
    }
  },
};
