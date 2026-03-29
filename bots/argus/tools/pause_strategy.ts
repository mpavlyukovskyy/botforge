/**
 * LLM Tool: pause_strategy — pause a strategy
 */

import { z } from 'zod';
import { getDb } from '../lib/db.js';

export default {
  name: 'pause_strategy',
  description: 'Pause a trading strategy. Strategy stops executing but positions remain open.',
  schema: {
    strategy: z.string().describe('Strategy ID to pause (funding-rate, yield, reserve, ondo-equities)'),
  },
  async execute(args: { strategy: string }, _ctx: any): Promise<string> {
    const db = getDb();

    const result = db.prepare(`
      UPDATE strategies SET status = 'paused', updated_at = datetime('now')
      WHERE id = ? AND status = 'active'
    `).run(args.strategy);

    if (result.changes > 0) {
      return `Strategy "${args.strategy}" paused successfully.`;
    } else {
      const current = db.prepare('SELECT status FROM strategies WHERE id = ?').get(args.strategy) as { status: string } | undefined;
      if (!current) return `Strategy "${args.strategy}" not found.`;
      return `Strategy "${args.strategy}" is already ${current.status}.`;
    }
  },
};
