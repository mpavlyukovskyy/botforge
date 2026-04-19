/**
 * Brain tool: search_products
 *
 * Search products by name across all sections.
 */
import { z } from 'zod';
import { ensureDb, searchProducts } from '../lib/db.js';

export default {
  name: 'search_products',
  description: 'Search for products by name across all sections. Returns matching products with their section, price, and express price.',
  schema: {
    query: z.string().describe('Search query (partial name match)'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available. Run refresh_cache first.';
    }

    const limit = Math.min(args.limit || 20, 50);
    const results = searchProducts(ctx.config, args.query, limit);

    if (results.length === 0) {
      return `No products matching "${args.query}".`;
    }

    const lines = [];
    lines.push(`Found ${results.length} product${results.length === 1 ? '' : 's'} matching "${args.query}":`);
    lines.push('');

    for (const p of results) {
      const price = p.price != null ? `$${parseFloat(p.price).toFixed(2)}` : 'no price';
      const express = p.express_price != null ? ` (express: $${parseFloat(p.express_price).toFixed(2)})` : '';
      const section = p.section_name ? ` [${p.section_name}]` : '';
      lines.push(`[${p.id}] ${p.name} — ${price}${express}${section}`);
    }

    return lines.join('\n');
  },
};
