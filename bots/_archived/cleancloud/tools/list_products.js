/**
 * Brain tool: list_products
 *
 * Lists products in a section with prices.
 */
import { z } from 'zod';
import { ensureDb, getProductsBySection, getProductCountBySection, getSection } from '../lib/db.js';

export default {
  name: 'list_products',
  description: 'List products in a specific section with their prices. Shows product ID, name, standard price, and express price.',
  schema: {
    section_id: z.string().describe('Section ID to list products from'),
    page: z.number().optional().describe('Page number (30 per page, default: 1)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available. Run refresh_cache first.';
    }

    const section = getSection(ctx.config, args.section_id);
    if (!section) {
      return `Section ${args.section_id} not found. Use list_sections to see available sections.`;
    }

    const pageSize = 30;
    const page = Math.max(1, args.page || 1);
    const offset = (page - 1) * pageSize;
    const totalCount = getProductCountBySection(ctx.config, args.section_id);
    const products = getProductsBySection(ctx.config, args.section_id, pageSize, offset);

    if (products.length === 0) {
      return `Section "${section.name}" has no products.`;
    }

    const totalPages = Math.ceil(totalCount / pageSize);
    const lines = [];
    lines.push(`${section.name} — ${totalCount} products:`);
    if (totalPages > 1) lines.push(`Showing ${offset + 1}-${offset + products.length} of ${totalCount} (page ${page}/${totalPages})`);
    lines.push('');

    for (const p of products) {
      const price = p.price != null ? `$${parseFloat(p.price).toFixed(2)}` : 'no price';
      const express = p.express_price != null ? ` (express: $${parseFloat(p.express_price).toFixed(2)})` : '';
      const parentTag = p.is_parent ? ' [PARENT]' : '';
      lines.push(`[${p.id}] ${p.name} — ${price}${express}${parentTag}`);
    }

    if (totalPages > 1 && page < totalPages) {
      lines.push('');
      lines.push(`Use page: ${page + 1} to see more.`);
    }

    return lines.join('\n');
  },
};
