/**
 * Command: /sleep [now]
 *
 * Acknowledges that Mark is going to bed. Writes a `source: skipped` override
 * for tonight's wake-date so any remaining wind-down phases exit silently.
 *
 * No follow-up. One reply, then silence — per Mark's "stop talking to me"
 * preference and the CBT-I principle that follow-up nags create failure
 * salience.
 */
import { ensureDb } from '../lib/db.js';
import { resolveWakeDate, setBedtimeOverride } from '../lib/bedtime-helper.js';

export default {
  command: 'sleep',
  description: 'Acknowledge bedtime, suppress remaining prompts tonight',
  async execute(args, ctx) {
    const chatId = ctx.chatId;
    ensureDb(ctx.config);

    const wakeDate = resolveWakeDate();
    setBedtimeOverride(ctx.config, wakeDate, {
      source: 'skipped',
    });

    await ctx.adapter.send({
      chatId,
      text: 'Acknowledged. Sleep well.',
    });
  },
};
