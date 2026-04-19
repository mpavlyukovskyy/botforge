/**
 * Brain tool: list_sections
 *
 * Lists all product sections with product counts.
 */
import { z } from 'zod';
import { ensureDb, getSectionsWithCounts } from '../lib/db.js';

export default {
  name: 'list_sections',
  description: 'List all product sections with their product counts. Returns section IDs, names, and how many products each contains.',
  schema: {
    page: z.number().optional().describe('Page number for pagination (20 per page, default: 1)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available. Run refresh_cache first.';
    }

    const sections = getSectionsWithCounts(ctx.config);
    if (sections.length === 0) {
      return 'No sections cached. Use refresh_cache to sync from CleanCloud.';
    }

    const pageSize = 20;
    const page = Math.max(1, args.page || 1);
    const start = (page - 1) * pageSize;
    const paged = sections.slice(start, start + pageSize);
    const totalPages = Math.ceil(sections.length / pageSize);

    const lines = [];
    lines.push(`Sections (${sections.length} total):`);
    if (totalPages > 1) lines.push(`Page ${page}/${totalPages}`);
    lines.push('');

    for (const s of paged) {
      lines.push(`[${s.id}] ${s.name} — ${s.product_count} products`);
    }

    if (totalPages > 1 && page < totalPages) {
      lines.push('');
      lines.push(`Use page: ${page + 1} to see more.`);
    }

    return lines.join('\n');
  },
};
