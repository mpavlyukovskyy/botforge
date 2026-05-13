/**
 * LLM Tool: get_yields — returns protocol yield data
 */

import { z } from 'zod';
import { getDb } from '../lib/db.js';

export default {
  name: 'get_yields',
  description: 'Get current protocol yields (Aave, sUSDe, USDY)',
  schema: {
    protocol: z.string().optional().describe('Filter by protocol'),
  },
  async execute(args: { protocol?: string }, _ctx: any): Promise<string> {
    const db = getDb();

    let query = `
      SELECT protocol, asset, apy, tvl, timestamp
      FROM yields
      WHERE (protocol, asset, timestamp) IN (
        SELECT protocol, asset, MAX(timestamp) FROM yields GROUP BY protocol, asset
      )
    `;

    const params: any[] = [];
    if (args.protocol) {
      query = `
        SELECT protocol, asset, apy, tvl, timestamp
        FROM yields
        WHERE protocol = ?
        ORDER BY timestamp DESC LIMIT 20
      `;
      params.push(args.protocol);
    }

    const yields = db.prepare(query).all(...params);
    return JSON.stringify(yields);
  },
};
