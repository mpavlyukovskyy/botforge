/**
 * Brain tool: price_history
 *
 * Query the operations log for price change history.
 * Read-only, no browser mutex needed.
 */
import { z } from 'zod';
import { ensureDb } from '../lib/db.js';

export default {
  name: 'price_history',
  description: 'Show recent price change history from the operations log. Can filter by product ID or action type.',
  schema: {
    product_id: z.string().optional().describe('Filter by product ID'),
    action: z.string().optional().describe('Filter by action type (e.g. "set_price", "bulk_set_prices", "adjust_prices")'),
    limit: z.number().optional().describe('Max results to return (default: 20)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const db = ensureDb(ctx.config);
    const limit = args.limit ?? 20;

    let query = 'SELECT * FROM operations WHERE 1=1';
    const params = [];

    if (args.product_id) {
      query += ' AND target_id = ?';
      params.push(args.product_id);
    }

    if (args.action) {
      query += ' AND action = ?';
      params.push(args.action);
    } else {
      // Default to price-related actions
      query += " AND action IN ('set_price', 'bulk_set_prices', 'adjust_prices')";
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(query).all(...params);

    if (rows.length === 0) {
      return 'No matching operations found.';
    }

    const lines = [`Price history (${rows.length} entries):\n`];

    for (const row of rows) {
      const time = row.created_at?.replace('T', ' ').substring(0, 19) || 'unknown';
      const who = row.user_name || row.user_id || 'system';
      const status = row.status === 'completed' ? '' : ` [${row.status}]`;
      lines.push(`[${time}] ${row.action} — ${row.description || 'no description'}${status} (by ${who})`);

      // Show details if available
      if (row.details_json) {
        try {
          const details = JSON.parse(row.details_json);
          if (Array.isArray(details)) {
            // bulk operation outcomes
            for (const d of details.slice(0, 5)) {
              const pricePart = d.price ? ` → $${Number(d.price).toFixed(2)}` : '';
              lines.push(`    ${d.name || d.product_id}${pricePart}${d.success ? '' : ' FAILED: ' + d.error}`);
            }
            if (details.length > 5) lines.push(`    ... and ${details.length - 5} more`);
          } else if (details.old_price !== undefined) {
            lines.push(`    $${details.old_price} → $${details.new_price} (express: $${details.old_express} → $${details.new_express})`);
          }
        } catch {}
      }
    }

    return lines.join('\n');
  },
};
