/**
 * LLM Tool: resume_strategy — resume a paused strategy
 */

import { z } from 'zod';
import { getDb } from '../lib/db.js';

export default {
  name: 'resume_strategy',
  description: 'Resume a paused strategy. Halted strategies cannot be resumed without manual review.',
  schema: {
    strategy: z.string().describe('Strategy ID to resume (funding-rate, yield, reserve, ondo-equities)'),
  },
  async execute(args: { strategy: string }, _ctx: any): Promise<string> {
    const db = getDb();

    const current = db.prepare('SELECT status FROM strategies WHERE id = ?').get(args.strategy) as { status: string } | undefined;
    if (!current) return `Strategy "${args.strategy}" not found.`;

    if (current.status === 'halted') {
      return `Strategy "${args.strategy}" is HALTED and cannot be resumed automatically. Run /reconcile first, then manually resume if safe.`;
    }

    if (current.status === 'active') {
      return `Strategy "${args.strategy}" is already active.`;
    }

    db.prepare(`
      UPDATE strategies SET status = 'active', updated_at = datetime('now')
      WHERE id = ?
    `).run(args.strategy);

    return `Strategy "${args.strategy}" resumed.`;
  },
};
