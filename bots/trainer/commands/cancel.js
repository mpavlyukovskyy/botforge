/**
 * Command: /cancel
 *
 * Discards any pending_program. The active (old) program continues unchanged
 * — the next program_rollover cron at 6:55am ET will try to design again.
 */
import { ensureDb } from '../lib/db.js';
import { getPendingProgram, clearPendingProgram } from '../lib/exercise-library.js';

export default {
  command: 'cancel',
  description: 'Discard a pending program',
  async execute(args, ctx) {
    const chatId = ctx.chatId;
    ensureDb(ctx.config);

    const pending = getPendingProgram(ctx.config, ctx.log);
    if (!pending) {
      await ctx.adapter.send({ chatId, text: 'Nothing to cancel.' });
      return;
    }

    clearPendingProgram(ctx.config);
    await ctx.adapter.send({
      chatId,
      text: 'Pending program discarded. Current program continues. Next design attempt at 6:55am ET tomorrow.',
    });
  },
};
