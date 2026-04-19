/**
 * Brain tool: compare_sections
 *
 * Fetch fresh data from API and compare against cached data.
 */
import { z } from 'zod';
import { ensureDb, getAllSections, getTotalProductCount } from '../lib/db.js';
import { getProducts } from '../lib/cleancloud-api.js';

export default {
  name: 'compare_sections',
  description: 'Compare cached section/product data against live CleanCloud API data. Useful for checking if cache is stale.',
  schema: {},
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available. Run refresh_cache first.';
    }

    const cachedSections = getAllSections(ctx.config);
    const cachedProductCount = getTotalProductCount(ctx.config);

    let liveProducts;
    try {
      liveProducts = await getProducts('0');
    } catch (err) {
      return `Failed to fetch live data: ${err.message}`;
    }

    // Extract live sections
    const liveSectionMap = new Map();
    for (const p of liveProducts) {
      const secId = String(p.section || p.sectionId || '');
      const secName = p.sectionName || p.section_name || '';
      if (secId && !liveSectionMap.has(secId)) {
        liveSectionMap.set(secId, secName);
      }
    }

    const lines = [];
    lines.push('Cache vs Live comparison:');
    lines.push('');
    lines.push(`Sections: ${cachedSections.length} cached / ${liveSectionMap.size} live`);
    lines.push(`Products: ${cachedProductCount} cached / ${liveProducts.length} live`);
    lines.push('');

    // Find differences
    const cachedIds = new Set(cachedSections.map(s => s.id));
    const liveIds = new Set(liveSectionMap.keys());

    const addedSections = [...liveIds].filter(id => !cachedIds.has(id));
    const removedSections = [...cachedIds].filter(id => !liveIds.has(id));

    if (addedSections.length > 0) {
      lines.push('New sections (in live, not cached):');
      for (const id of addedSections) {
        lines.push(`  + [${id}] ${liveSectionMap.get(id)}`);
      }
    }

    if (removedSections.length > 0) {
      lines.push('Removed sections (in cache, not live):');
      for (const id of removedSections) {
        const s = cachedSections.find(s => s.id === id);
        lines.push(`  - [${id}] ${s?.name || 'unknown'}`);
      }
    }

    if (addedSections.length === 0 && removedSections.length === 0) {
      lines.push('Section lists match.');
    }

    const productDiff = liveProducts.length - cachedProductCount;
    if (productDiff !== 0) {
      lines.push(`Product count difference: ${productDiff > 0 ? '+' : ''}${productDiff}`);
    }

    lines.push('');
    lines.push('Use refresh_cache to update the local cache with live data.');

    return lines.join('\n');
  },
};
