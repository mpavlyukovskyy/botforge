import { z } from 'zod';
import { computeBalance } from '../lib/db.js';

/**
 * Report monthly (or all-time) balance — earnings, deductions, overdue debt.
 * Pure read-only aggregation over local DB (tasks + deductions).
 */
const getBalance = {
  name: 'get_balance',
  description: 'Get current balance summary. Defaults to this month.',
  schema: {
    period: z.enum(['this_month', 'all_time']).optional().describe("Period: 'this_month' (default) or 'all_time'"),
  },
  execute: async (args, ctx) => {
    try {
      const period = args.period === 'all_time' ? 'all_time' : 'this_month';
      return computeBalance(ctx, period);
    } catch (err) {
      return `Error getting balance: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export default getBalance;
