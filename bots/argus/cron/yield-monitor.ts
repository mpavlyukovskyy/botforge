/**
 * Cron: yield_monitor — runs every 5 minutes
 *
 * Polls Aave V3, sUSDe, and USDY yields.
 * Stores in SQLite yields table.
 */

import { getDb } from '../lib/db.js';
import type { ArbitrumAdapter } from '../execution/arbitrum.js';

// Adapter set from lifecycle/start.ts
let arbAdapter: ArbitrumAdapter | null = null;

export function setArbitrumAdapter(adapter: ArbitrumAdapter): void {
  arbAdapter = adapter;
}

const ETHENA_YIELDS_URL = 'https://ethena.fi/api/yields/protocol-and-staking-yield';
const USDY_HARDCODED_APY = 0.045; // 4.5% — Ondo updates infrequently

export default {
  name: 'yield_monitor',
  async execute(ctx: any) {
    const db = getDb();

    const insertYield = db.prepare(`
      INSERT INTO yields (timestamp, protocol, asset, apy, tvl)
      VALUES (datetime('now'), ?, ?, ?, ?)
    `);

    // 1. Aave V3 on Arbitrum (on-chain via adapter)
    if (arbAdapter?.isConnected()) {
      try {
        const rates = await arbAdapter.getAaveSupplyRates();
        for (const { asset, supplyApy } of rates) {
          insertYield.run('aave-v3', asset, supplyApy, null);
        }
      } catch (err) {
        ctx.log.warn(`Yield monitor: Aave rates failed: ${err}`);
      }
    }

    // 2. sUSDe yield from Ethena public API
    try {
      const response = await fetch(ETHENA_YIELDS_URL, {
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const data = await response.json() as any;
        // Extract sUSDe staking APY — API returns percentage (e.g. 15.2 for 15.2%)
        const stakingYield = data?.stakingYield?.value ?? data?.stakingYield;
        if (typeof stakingYield === 'number' && stakingYield > 0) {
          insertYield.run('ethena', 'sUSDe', stakingYield / 100, null);
        }
      } else {
        ctx.log.warn(`Yield monitor: Ethena API returned ${response.status}`);
      }
    } catch (err) {
      ctx.log.warn(`Yield monitor: Ethena API failed: ${err}`);
    }

    // 3. USDY yield (hardcoded — Ondo rate changes infrequently)
    try {
      insertYield.run('ondo', 'USDY', USDY_HARDCODED_APY, null);
    } catch (err) {
      ctx.log.warn(`Yield monitor: USDY insert failed: ${err}`);
    }
  },
};
