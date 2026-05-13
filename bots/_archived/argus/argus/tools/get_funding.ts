/**
 * LLM Tool: get_funding — returns funding rate data
 */

import { z } from 'zod';
import { getDb } from '../lib/db.js';

export default {
  name: 'get_funding',
  description: 'Get current and historical funding rates',
  schema: {
    asset: z.string().optional().describe('Filter by asset (ETH, BTC, SOL)'),
    hours: z.number().optional().describe('Hours of history to return (default: 24)'),
  },
  async execute(args: { asset?: string; hours?: number }, _ctx: any): Promise<string> {
    const db = getDb();
    const hours = args.hours ?? 24;

    let query = `
      SELECT asset, rate, annualized, exchange, timestamp
      FROM funding_rates
      WHERE timestamp > datetime('now', '-${hours} hours')
    `;

    const params: any[] = [];
    if (args.asset) {
      query += ' AND asset = ?';
      params.push(args.asset);
    }

    query += ' ORDER BY timestamp DESC';

    const rates = db.prepare(query).all(...params);
    return JSON.stringify(rates);
  },
};
