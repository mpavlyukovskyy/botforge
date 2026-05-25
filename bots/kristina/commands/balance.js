import { computeBalance } from '../lib/db.js';

/**
 * /balance — print this-month or all-time financial summary.
 * Bypasses the brain (zero cost, instant response).
 */
export default {
  command: 'balance',
  description: 'Show this-month earnings, deductions, and overdue tasks. Use "/balance all" for all-time.',
  async execute(args, ctx) {
    const period = String(args || '').trim().toLowerCase() === 'all' ? 'all_time' : 'this_month';
    const summary = computeBalance(ctx, period);
    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: '```\n' + summary + '\n```',
      parseMode: 'Markdown',
    });
  },
};
