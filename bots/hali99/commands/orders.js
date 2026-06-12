/**
 * /orders [yesterday|YYYY-MM-DD] — today's (or a given NZ day's) orders:
 * who's ordered, paid state, ack state. Text formatted by the dashboard.
 */
import { runStatusCommand } from '../lib/findlays-api.js';

export default {
  command: 'orders',
  description: "Today's orders (online + POS) with paid/ack state",
  async execute(args, ctx) {
    const arg = String(args || '').trim();
    const date = arg ? `&date=${encodeURIComponent(arg)}` : '';
    await runStatusCommand(ctx, `/api/telegram-bot/orders-status?view=today${date}`);
  },
};
