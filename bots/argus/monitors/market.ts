/**
 * Argus Trading System — Market Data Monitor
 *
 * Two modes of operation:
 * 1. Cron handler (default export) — periodic snapshot polling
 * 2. WebSocket subscriber (startWebSocket) — continuous real-time data
 *
 * Collects:
 * - Asset prices (BTC, ETH, SOL)
 * - Funding rates (Hyperliquid)
 * - Open interest
 *
 * Stores everything in SQLite (prices, funding_rates tables).
 * Detects data gaps and alerts when WebSocket drops or RPC fails.
 */

import { HyperliquidAdapter } from '../execution/hyperliquid.js';
import type { FundingRate, PriceData } from '../lib/types.js';
import { getDb } from '../lib/db.js';
import { STRATEGY_CONFIG, IS_TESTNET } from '../lib/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MonitorContext {
  /** Send alert to configured channels */
  sendAlert: (severity: 'info' | 'warning' | 'critical', title: string, message: string) => Promise<void>;
}

interface CronHandler {
  name: string;
  execute: (ctx: MonitorContext) => Promise<void>;
}

// ─── Shared Adapter Instance ─────────────────────────────────────────────────

let sharedAdapter: HyperliquidAdapter | null = null;

async function getAdapter(): Promise<HyperliquidAdapter> {
  if (sharedAdapter?.isConnected()) return sharedAdapter;

  sharedAdapter = new HyperliquidAdapter({ testnet: IS_TESTNET });
  await sharedAdapter.connect();
  return sharedAdapter;
}

// ─── Write Batching ──────────────────────────────────────────────────────────

interface PriceBatchEntry {
  asset: string;
  price: number;
  timestamp: string;
}

let priceBatch: PriceBatchEntry[] = [];
let batchTimer: ReturnType<typeof setInterval> | null = null;
const BATCH_INTERVAL_MS = 10_000; // Flush every 10 seconds

function flushPriceBatch(): void {
  if (priceBatch.length === 0) return;

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO prices (timestamp, asset, price, source)
    VALUES (?, ?, ?, 'hyperliquid')
  `);

  const batch = priceBatch;
  priceBatch = [];

  // Deduplicate — keep only latest per asset
  const latest = new Map<string, PriceBatchEntry>();
  for (const entry of batch) {
    latest.set(entry.asset, entry);
  }

  for (const entry of latest.values()) {
    try {
      insert.run(entry.timestamp, entry.asset, entry.price);
    } catch { /* ignore duplicate or db errors during batch write */ }
  }
}

function startBatchTimer(): void {
  if (batchTimer) return;
  batchTimer = setInterval(flushPriceBatch, BATCH_INTERVAL_MS);
}

function stopBatchTimer(): void {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }
  // Flush remaining
  flushPriceBatch();
}

// ─── Cron Handler ─────────────────────────────────────────────────────────────

/**
 * Market data cron handler.
 *
 * Runs on a periodic schedule (e.g. every 5 minutes) to:
 * 1. Poll Hyperliquid REST API for current prices and funding rates
 * 2. Store snapshots in SQLite
 * 3. Detect data gaps (missing data points since last run)
 * 4. Alert on stale data
 */
const marketMonitor: CronHandler = {
  name: 'market_monitor',

  async execute(ctx: MonitorContext): Promise<void> {
    const db = getDb();
    const assets = STRATEGY_CONFIG['funding-rate'].assets;
    const timestamp = new Date().toISOString();

    const adapter = await getAdapter();

    // Fetch all mid prices in a single call
    const allPrices = await adapter.getAllMidPrices();

    for (const assetName of assets) {
      // Store price
      const price = allPrices[assetName];
      if (price !== undefined) {
        storePrice({
          timestamp,
          asset: assetName,
          price,
          source: 'hyperliquid',
        });
      }

      // Fetch and store funding rate
      try {
        const funding = await adapter.getFundingRate(assetName);
        storeFundingRate({
          id: 0,
          timestamp,
          asset: assetName,
          exchange: 'hyperliquid',
          rate: funding.rate,
          annualized: funding.annualized,
        });
      } catch {
        // Some assets may not have funding data — skip
      }
    }

    // Check for data gaps
    await detectDataGaps(db, assets, ctx);
  },
};

export default marketMonitor;

// ─── WebSocket Subscriber ───────────────────────────────────────────────────

/**
 * Start WebSocket connection for continuous market data.
 *
 * Subscribes to:
 * - Price updates for all funding-rate strategy assets
 * - Funding rate updates (if wallet is configured)
 *
 * Data is written to SQLite at a throttled rate (batched every 10 seconds).
 */
export async function startWebSocket(ctx: MonitorContext): Promise<void> {
  const assets = new Set(STRATEGY_CONFIG['funding-rate'].assets);
  const adapter = await getAdapter();

  // Start batch timer
  startBatchTimer();

  // Subscribe to all mid prices
  await adapter.subscribeToPrices((asset: string, price: number) => {
    // Only track assets we care about
    if (!assets.has(asset)) return;

    priceBatch.push({
      asset,
      price,
      timestamp: new Date().toISOString(),
    });
  });

  // Monitor for disconnection — check every 60 seconds
  const healthCheck = setInterval(async () => {
    if (!adapter.isConnected()) {
      await ctx.sendAlert(
        'warning',
        'WebSocket Disconnected',
        'Market data WebSocket is disconnected. Attempting reconnect...',
      );

      try {
        await adapter.disconnect();
        sharedAdapter = null;
        const newAdapter = await getAdapter();

        await newAdapter.subscribeToPrices((asset: string, price: number) => {
          if (!assets.has(asset)) return;
          priceBatch.push({
            asset,
            price,
            timestamp: new Date().toISOString(),
          });
        });

        await ctx.sendAlert(
          'info',
          'WebSocket Reconnected',
          'Market data WebSocket has been re-established.',
        );
      } catch (err) {
        await ctx.sendAlert(
          'critical',
          'WebSocket Reconnect Failed',
          `Failed to reconnect WebSocket: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }, 60_000);

  // Store cleanup reference (called on shutdown)
  (startWebSocket as any)._cleanup = () => {
    clearInterval(healthCheck);
    stopBatchTimer();
    adapter.disconnect();
  };
}

/**
 * Stop the WebSocket subscriber and flush remaining data.
 */
export function stopWebSocket(): void {
  stopBatchTimer();
  if (sharedAdapter) {
    sharedAdapter.disconnect();
    sharedAdapter = null;
  }
  const cleanup = (startWebSocket as any)._cleanup;
  if (cleanup) cleanup();
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Detect gaps in market data and alert if data is stale.
 */
async function detectDataGaps(
  db: ReturnType<typeof getDb>,
  assets: readonly string[],
  ctx: MonitorContext,
): Promise<void> {
  const staleThresholdMinutes = 10;

  for (const asset of assets) {
    const latest = db.prepare(`
      SELECT timestamp FROM prices
      WHERE asset = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(asset) as { timestamp: string } | undefined;

    if (!latest) {
      await ctx.sendAlert(
        'warning',
        'Missing Market Data',
        `No price data found for ${asset}. Data collection may not be running.`,
      );
      continue;
    }

    const ageMinutes = (Date.now() - new Date(latest.timestamp).getTime()) / 60_000;

    if (ageMinutes > staleThresholdMinutes) {
      await ctx.sendAlert(
        'warning',
        'Stale Market Data',
        `Latest ${asset} price is ${Math.round(ageMinutes)} minutes old. Expected refresh within ${staleThresholdMinutes} minutes.`,
      );
    }
  }
}

/**
 * Store a funding rate record in the database.
 */
function storeFundingRate(data: FundingRate): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO funding_rates (timestamp, asset, exchange, rate, annualized)
    VALUES (?, ?, ?, ?, ?)
  `).run(data.timestamp, data.asset, data.exchange, data.rate, data.annualized);
}

/**
 * Store a price record in the database.
 */
function storePrice(data: Omit<PriceData, 'id'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO prices (timestamp, asset, price, source)
    VALUES (?, ?, ?, ?)
  `).run(data.timestamp, data.asset, data.price, data.source);
}
