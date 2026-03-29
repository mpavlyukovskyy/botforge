/**
 * LLM Tool: get_positions — returns all open positions
 */

import { z } from 'zod';
import { getDb } from '../lib/db.js';

export default {
  name: 'get_positions',
  description: 'Get all open positions across all strategies',
  schema: {
    strategy: z.string().optional().describe('Filter by strategy ID'),
  },
  async execute(args: { strategy?: string }, _ctx: any): Promise<string> {
    const db = getDb();

    let query = 'SELECT * FROM positions';
    const params: any[] = [];

    if (args.strategy) {
      query += ' WHERE strategy = ?';
      params.push(args.strategy);
    }

    query += ' ORDER BY strategy, protocol, asset';

    const positions = db.prepare(query).all(...params);
    return JSON.stringify(positions);
  },
};
