/**
 * Cron: market_monitor — runs every minute
 *
 * Collects prices and funding rates from Hyperliquid.
 * Stores in SQLite for strategy consumption.
 */

import { getDb } from '../lib/db.js';
import { STRATEGY_CONFIG, ALERT_CONFIG } from '../lib/config.js';
import type { HyperliquidAdapter } from '../execution/hyperliquid.js';

let hlAdapter: HyperliquidAdapter | null = null;

export function setHyperliquidAdapter(adapter: HyperliquidAdapter): void {
  hlAdapter = adapter;
}

export default {
  name: 'market_monitor',
  async execute(ctx: any) {
    const db = getDb();

    try {
      // Ping healthchecks.io to confirm bot is alive
      if (ALERT_CONFIG.healthchecksPingUrl) {
        fetch(ALERT_CONFIG.healthchecksPingUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        }).catch(() => {}); // Fire and forget
      }

      if (!hlAdapter?.isConnected()) return;

      // Fetch all mid prices
      const mids = await hlAdapter.getAllMidPrices();

      // Store prices for configured assets
      const assets = STRATEGY_CONFIG['funding-rate'].assets;
      const insertPrice = db.prepare(`
        INSERT INTO prices (timestamp, asset, price, source)
        VALUES (datetime('now'), ?, ?, 'hyperliquid')
      `);

      for (const asset of assets) {
        const price = mids[asset];
        if (price && price > 0) {
          insertPrice.run(asset, price);
        }
      }
    } catch (err) {
      ctx.log.error(`Market monitor error: ${err}`);
    }
  },
};
