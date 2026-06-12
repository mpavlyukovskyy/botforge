/**
 * /order <id> — full status card for one order (status, paid, ack history).
 */
import { runStatusCommand, parseOrderId } from '../lib/findlays-api.js';

export default {
  command: 'order',
  description: 'Status of one order: /order 8300',
  async execute(args, ctx) {
    const id = parseOrderId(args);
    if (!id) {
      await ctx.adapter.send({ chatId: ctx.chatId, text: 'Usage: /order <id> — e.g. /order 8300' });
      return;
    }
    await runStatusCommand(ctx, `/api/telegram-bot/orders-status?view=order&id=${encodeURIComponent(id)}`);
  },
};
