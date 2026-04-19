/**
 * Brain tool: compare_prices
 *
 * Compare product prices across multiple price lists.
 * Read-only, no browser mutex needed.
 */
import { z } from 'zod';
import { ensureDb } from '../lib/db.js';

export default {
  name: 'compare_prices',
  description: 'Compare product prices across different price lists. Useful for seeing what different customers pay versus retail.',
  schema: {
    section_id: z.string().optional().describe('Filter by section ID'),
    product_ids: z.array(z.string()).optional().describe('Specific product IDs to compare'),
    product_name: z.string().optional().describe('Search products by name (partial match)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const db = ensureDb(ctx.config);

    // Get all price lists
    const priceLists = db.prepare('SELECT * FROM price_lists ORDER BY id').all();
    if (priceLists.length === 0) {
      return 'No price lists found. Run refresh_cache first.';
    }

    // Build product filter
    let productQuery = 'SELECT p.id, p.name, p.section_id, s.name as section_name FROM products p LEFT JOIN sections s ON s.id = p.section_id WHERE 1=1';
    const productParams = [];

    if (args.product_ids?.length) {
      productQuery += ` AND p.id IN (${args.product_ids.map(() => '?').join(',')})`;
      productParams.push(...args.product_ids);
    }

    if (args.section_id) {
      productQuery += ' AND p.section_id = ?';
      productParams.push(args.section_id);
    }

    if (args.product_name) {
      productQuery += ' AND p.name LIKE ?';
      productParams.push(`%${args.product_name}%`);
    }

    productQuery += ' ORDER BY p.section_id, p.sort_order, p.name LIMIT 30';

    const products = db.prepare(productQuery).all(...productParams);

    if (products.length === 0) {
      return 'No products found matching your criteria.';
    }

    // Build header
    const plNames = [{ id: '0', name: 'Retail' }, ...priceLists];
    const lines = [];
    lines.push('Price comparison across lists:\n');

    // For each product, fetch prices from all lists
    const priceStmt = db.prepare('SELECT price, express_price FROM product_prices WHERE product_id = ? AND price_list_id = ?');

    let currentSection = null;
    for (const product of products) {
      if (product.section_name && product.section_name !== currentSection) {
        currentSection = product.section_name;
        lines.push(`\n--- ${currentSection} ---`);
      }

      const prices = [];
      for (const pl of plNames) {
        const pp = priceStmt.get(product.id, String(pl.id));
        prices.push(pp?.price ? `$${Number(pp.price).toFixed(2)}` : '—');
      }

      lines.push(`${product.name}: ${plNames.map((pl, i) => `${pl.name}=${prices[i]}`).join(', ')}`);
    }

    lines.push(`\n${products.length} products compared across ${plNames.length} price lists.`);

    return lines.join('\n');
  },
};
