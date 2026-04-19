/**
 * Lifecycle hook: start
 *
 * Runs DB migrations and verifies CleanCloud API connectivity.
 */
import { runMigrations, ensureDb, getLastSync } from '../lib/db.js';

export default {
  event: 'start',
  async execute(ctx) {
    runMigrations(ctx);
    ctx.log.info('CleanCloud DB migrations complete');

    // Verify CleanCloud API connectivity
    const apiToken = process.env.CLEANCLOUD_API_TOKEN;
    if (apiToken) {
      try {
        const res = await fetch('https://cleancloudapp.com/api/getProducts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_token: apiToken, inStore: '1' }),
        });
        if (res.ok) {
          const data = await res.json();
          const count = data.Products?.length ?? 0;
          ctx.log.info(`CleanCloud API connected (${count} products)`);
        } else {
          ctx.log.warn(`CleanCloud API check failed: ${res.status}`);
        }
      } catch (err) {
        ctx.log.warn(`CleanCloud API unreachable: ${err.message}`);
      }
    } else {
      ctx.log.warn('CLEANCLOUD_API_TOKEN not set — API integration disabled');
    }

    // Store config in shared store
    ctx.store.set('timezone', 'Pacific/Auckland');
    ctx.store.set('chat_id', process.env.CLEANCLOUD_CHAT_ID || ctx.config.platform?.chat_ids?.[0]);
    ctx.store.set('cdp_port', process.env.CLEANCLOUD_CDP_PORT || '9230');

    // Check last sync
    const lastSync = getLastSync(ctx.config);
    if (lastSync) {
      ctx.log.info(`Last sync: ${lastSync.synced_at} (${lastSync.product_count} products, ${lastSync.section_count} sections)`);
    } else {
      ctx.log.info('No sync data yet — will sync on first cron run or manual refresh');
    }

    ctx.log.info('CleanCloud bot started');
  },
};
