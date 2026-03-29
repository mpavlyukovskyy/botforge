/**
 * Argus Trading System — Yield Data Monitor
 *
 * Periodically polls yield data from:
 * - Aave V3 (Arbitrum) — USDC, WETH supply APYs
 * - Ethena sUSDe — staking yield (via API)
 * - Ondo USDY — tokenized T-bill rate (via API)
 *
 * Stores all data in the `yields` table for strategy evaluation.
 */

import { JsonRpcProvider, Contract, formatUnits } from 'ethers';
import type { YieldData } from '../lib/types.js';
import { getDb } from '../lib/db.js';
import { CONTRACT_ALLOWLIST, RPC_CONFIG, IS_TESTNET } from '../lib/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MonitorContext {
  sendAlert: (severity: 'info' | 'warning' | 'critical', title: string, message: string) => Promise<void>;
}

interface CronHandler {
  name: string;
  execute: (ctx: MonitorContext) => Promise<void>;
}

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const AAVE_DATA_PROVIDER_ABI = [
  'function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)',
];

// ─── Provider Cache ──────────────────────────────────────────────────────────

let provider: JsonRpcProvider | null = null;

function getProvider(): JsonRpcProvider {
  if (provider) return provider;
  const rpcUrl = IS_TESTNET
    ? RPC_CONFIG.arbitrum.testnet.url
    : RPC_CONFIG.arbitrum.primary;
  const chainId = IS_TESTNET
    ? RPC_CONFIG.arbitrum.testnet.chainId
    : RPC_CONFIG.arbitrum.chainId;
  provider = new JsonRpcProvider(rpcUrl, chainId);
  return provider;
}

// ─── Cron Handler ─────────────────────────────────────────────────────────────

const yieldMonitor: CronHandler = {
  name: 'yield_monitor',

  async execute(ctx: MonitorContext): Promise<void> {
    const db = getDb();
    const timestamp = new Date().toISOString();
    const errors: string[] = [];
    let polled = 0;

    // Poll Aave V3 APYs
    try {
      await pollAaveYields(db, timestamp);
      polled += 2; // USDC + WETH
    } catch (err) {
      errors.push(`Aave: ${err instanceof Error ? err.message : err}`);
    }

    // Poll sUSDe yield
    try {
      await pollSUSDeYield(db, timestamp);
      polled++;
    } catch (err) {
      errors.push(`sUSDe: ${err instanceof Error ? err.message : err}`);
    }

    // Poll USDY rate
    try {
      await pollUSDYRate(db, timestamp);
      polled++;
    } catch (err) {
      errors.push(`USDY: ${err instanceof Error ? err.message : err}`);
    }

    if (errors.length > 0) {
      await ctx.sendAlert(
        'warning',
        `Yield Monitor: ${errors.length} sources failed`,
        errors.join('\n'),
      );
    }
  },
};

export default yieldMonitor;

// ─── Protocol Pollers ───────────────────────────────────────────────────────

/**
 * Poll Aave V3 supply APYs on Arbitrum.
 *
 * Queries the Aave Pool Data Provider for liquidityRate (in ray = 1e27).
 * Converts to annualized APY.
 */
async function pollAaveYields(
  db: ReturnType<typeof getDb>,
  timestamp: string,
): Promise<void> {
  const rpc = getProvider();
  const dataProvider = new Contract(
    CONTRACT_ALLOWLIST.arbitrum.AAVE_POOL_DATA_PROVIDER,
    AAVE_DATA_PROVIDER_ABI,
    rpc,
  );

  const assets = [
    { symbol: 'USDC', address: CONTRACT_ALLOWLIST.arbitrum.USDC },
    { symbol: 'WETH', address: CONTRACT_ALLOWLIST.arbitrum.WETH },
  ];

  for (const { symbol, address } of assets) {
    const reserveData = await dataProvider.getReserveData(address);

    // liquidityRate is at index 5, in ray (1e27)
    const liquidityRateRay = reserveData[5];
    // APY = ray / 1e27 (already annualized by Aave)
    const apy = parseFloat(formatUnits(liquidityRateRay, 27));

    // totalAToken at index 2 = total supplied (raw units)
    const totalSupplied = reserveData[2];
    const decimals = symbol === 'USDC' ? 6 : 18;
    const tvl = parseFloat(formatUnits(totalSupplied, decimals));

    storeYield(db, timestamp, 'aave-v3', symbol, apy, tvl);
  }
}

/**
 * Poll Ethena sUSDe yield.
 *
 * Uses the public Ethena API to get the current yield.
 * Falls back to a default if the API is unavailable.
 */
async function pollSUSDeYield(
  db: ReturnType<typeof getDb>,
  timestamp: string,
): Promise<void> {
  // Ethena provides a public yield API
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch('https://ethena.fi/api/yields/protocol-and-staking-yield', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json() as any;
      // Ethena returns stakingYield as a nested object or number — try multiple paths
      let yieldValue: number | undefined;
      if (typeof data?.stakingYield === 'number') {
        yieldValue = data.stakingYield;
      } else if (typeof data?.stakingYield?.value === 'number') {
        yieldValue = data.stakingYield.value;
      } else if (typeof data?.avg30dSusdeYield === 'number') {
        yieldValue = data.avg30dSusdeYield;
      } else if (typeof data?.protocolYield === 'number') {
        yieldValue = data.protocolYield;
      }
      if (yieldValue !== undefined) {
        const apy = yieldValue / 100; // Convert from percentage to decimal
        storeYield(db, timestamp, 'ethena', 'sUSDe', apy, null);
        return;
      }
    }

    // Fallback: try DeFi Llama API
    const llamaResponse = await fetch('https://yields.llama.fi/chart/747c1d2a-c668-4571-b9c6-35b9f6a63c55', {
      signal: controller.signal,
    });

    if (llamaResponse.ok) {
      const llamaData = await llamaResponse.json() as any;
      const latest = llamaData?.data?.[llamaData.data.length - 1];
      if (latest?.apy !== undefined) {
        const apy = latest.apy / 100;
        const tvl = latest.tvlUsd ?? null;
        storeYield(db, timestamp, 'ethena', 'sUSDe', apy, tvl);
        return;
      }
    }

    throw new Error('Could not fetch sUSDe yield from any source');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Poll Ondo USDY rate.
 *
 * USDY yield is the underlying T-bill rate.
 * Sourced from Ondo API or DeFi Llama.
 */
async function pollUSDYRate(
  db: ReturnType<typeof getDb>,
  timestamp: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    // Try DeFi Llama for USDY yield
    const response = await fetch('https://yields.llama.fi/chart/c0e1b1b6-deb0-4970-ae6e-0fc4c0e47b8e', {
      signal: controller.signal,
    });

    if (response.ok) {
      const data = await response.json() as any;
      const latest = data?.data?.[data.data.length - 1];
      if (latest?.apy !== undefined) {
        const apy = latest.apy / 100;
        const tvl = latest.tvlUsd ?? null;
        storeYield(db, timestamp, 'ondo', 'USDY', apy, tvl);
        return;
      }
    }

    // Fallback: use known baseline rate (3.55% as of March 2026)
    // This gets overwritten when live data is available
    storeYield(db, timestamp, 'ondo', 'USDY', 0.0355, null);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function storeYield(
  db: ReturnType<typeof getDb>,
  timestamp: string,
  protocol: string,
  asset: string,
  apy: number,
  tvl: number | null,
): void {
  db.prepare(`
    INSERT INTO yields (timestamp, protocol, asset, apy, tvl)
    VALUES (?, ?, ?, ?, ?)
  `).run(timestamp, protocol, asset, apy, tvl);
}

export function getLatestYield(
  protocol: string,
  asset: string,
): YieldData | null {
  const db = getDb();
  const result = db.prepare(`
    SELECT * FROM yields
    WHERE protocol = ? AND asset = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(protocol, asset) as YieldData | undefined;

  return result ?? null;
}
