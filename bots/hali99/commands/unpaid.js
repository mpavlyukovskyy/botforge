/**
 * /unpaid — unpaid online orders over the last 7 NZ days (+ POS one-liner).
 */
import { runStatusCommand } from '../lib/findlays-api.js';

export default {
  command: 'unpaid',
  description: 'Unpaid online orders (last 7 days)',
  async execute(args, ctx) {
    await runStatusCommand(ctx, '/api/telegram-bot/orders-status?view=unpaid');
  },
};
