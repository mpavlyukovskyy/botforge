/**
 * /pause [strategy] — Pause a specific strategy or all strategies
 */

import { getDb } from '../lib/db.js';
import type { StrategyId } from '../lib/types.js';

const VALID_STRATEGIES: StrategyId[] = ['funding-rate', 'yield', 'reserve', 'ondo-equities'];

export default {
  command: 'pause',
  description: 'Pause a strategy (or all)',
  async execute(args: string, ctx: any) {
    const db = getDb();
    const target = args.trim().toLowerCase();

    if (!target || target === 'all') {
      // Pause all active strategies
      db.prepare(`
        UPDATE strategies SET status = 'paused', updated_at = datetime('now')
        WHERE status = 'active'
      `).run();

      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: '⏸️ All strategies paused.',
      });
      return;
    }

    if (!VALID_STRATEGIES.includes(target as StrategyId)) {
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `Unknown strategy: ${target}\nValid: ${VALID_STRATEGIES.join(', ')}`,
      });
      return;
    }

    const result = db.prepare(`
      UPDATE strategies SET status = 'paused', updated_at = datetime('now')
      WHERE id = ? AND status = 'active'
    `).run(target);

    if (result.changes > 0) {
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `⏸️ Strategy *${target}* paused.`,
      });
    } else {
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `Strategy *${target}* is not active (current status may be paused/halted).`,
      });
    }
  },
};
