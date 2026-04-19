/**
 * Context builder: catalog_summary
 *
 * Injects section/product counts and last sync time.
 */
import { ensureDb, getTotalProductCount, getTotalSectionCount, getLastSync } from '../lib/db.js';

export default {
  type: 'catalog_summary',
  async build(ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return '';
    }

    const products = getTotalProductCount(ctx.config);
    const sections = getTotalSectionCount(ctx.config);
    const lastSync = getLastSync(ctx.config);

    if (products === 0 && sections === 0) {
      return '<catalog_summary>No data cached yet. Use refresh_cache to sync from CleanCloud API.</catalog_summary>';
    }

    const syncInfo = lastSync
      ? `last_sync: ${lastSync.synced_at}`
      : 'never synced';

    return `<catalog_summary>${sections} sections, ${products} products | ${syncInfo}</catalog_summary>`;
  },
};
