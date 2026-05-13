/**
 * /resume [strategy] — Resume a paused strategy
 */

import { getDb } from '../lib/db.js';
import type { StrategyId } from '../lib/types.js';

const VALID_STRATEGIES: StrategyId[] = ['funding-rate', 'yield', 'reserve', 'ondo-equities'];

export default {
  command: 'resume',
  description: 'Resume a paused strategy',
  async execute(args: string, ctx: any) {
    const db = getDb();
    const target = args.trim().toLowerCase();

    if (!target || target === 'all') {
      // Resume all paused strategies (NOT halted — those need manual review)
      db.prepare(`
        UPDATE strategies SET status = 'active', updated_at = datetime('now')
        WHERE status = 'paused'
      `).run();

      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: '▶️ All paused strategies resumed. Halted strategies require manual review.',
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

    // Check current status
    const strategy = db.prepare(
      'SELECT status FROM strategies WHERE id = ?'
    ).get(target) as { status: string } | undefined;

    if (!strategy) {
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `Strategy *${target}* not found.`,
      });
      return;
    }

    if (strategy.status === 'halted') {
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `Strategy *${target}* is HALTED (not just paused). Run /reconcile first, then use /resume ${target} --force if safe.`,
      });
      return;
    }

    if (strategy.status === 'active') {
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `Strategy *${target}* is already active.`,
      });
      return;
    }

    db.prepare(`
      UPDATE strategies SET status = 'active', updated_at = datetime('now')
      WHERE id = ?
    `).run(target);

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: `▶️ Strategy *${target}* resumed.`,
    });
  },
};
