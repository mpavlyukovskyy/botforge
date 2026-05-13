/**
 * Argus Connectivity Test
 *
 * Verifies connections to:
 * 1. Hyperliquid testnet (REST + WebSocket)
 * 2. Arbitrum Sepolia RPC
 * 3. Yield data sources (APIs)
 *
 * Run: ARGUS_TESTNET=true npx tsx bots/argus/scripts/test-connectivity.ts
 */

import { HyperliquidAdapter } from '../execution/hyperliquid.js';
import { JsonRpcProvider, formatUnits } from 'ethers';
import { RPC_CONFIG } from '../lib/config.js';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';

interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

const results: TestResult[] = [];

function record(name: string, status: 'pass' | 'fail' | 'warn', detail: string) {
  const icon = status === 'pass' ? PASS : status === 'fail' ? FAIL : WARN;
  console.log(`  ${icon} ${name}: ${detail}`);
  results.push({ name, status, detail });
}

async function testHyperliquid(): Promise<void> {
  console.log('\n=== Hyperliquid Testnet ===\n');

  const isTestnet = process.env.ARGUS_TESTNET === 'true';
  const adapter = new HyperliquidAdapter({ testnet: isTestnet });

  // 1. Connect (no wallet needed for read-only)
  try {
    await adapter.connect();
    record('Connection', 'pass', `Connected (testnet=${isTestnet})`);
  } catch (err) {
    record('Connection', 'fail', `${err instanceof Error ? err.message : err}`);
    return;
  }

  // 2. Fetch prices
  try {
    const prices = await adapter.getAllMidPrices();
    const count = Object.keys(prices).length;
    const ethPrice = prices['ETH'] ?? prices['@1'];
    record('Mid Prices', 'pass', `${count} assets (ETH=${ethPrice ?? 'N/A'})`);
  } catch (err) {
    record('Mid Prices', 'fail', `${err instanceof Error ? err.message : err}`);
  }

  // 3. Fetch funding rate
  try {
    const funding = await adapter.getFundingRate('ETH');
    record('Funding Rate', 'pass',
      `ETH: ${(funding.rate * 100).toFixed(4)}% per 8h (${(funding.annualized * 100).toFixed(2)}% ann.)`);
  } catch (err) {
    record('Funding Rate', 'fail', `${err instanceof Error ? err.message : err}`);
  }

  // 4. Fetch open interest
  try {
    const oi = await adapter.getOpenInterest('ETH');
    record('Open Interest', 'pass', `ETH: $${(oi / 1e6).toFixed(2)}M`);
  } catch (err) {
    record('Open Interest', 'fail', `${err instanceof Error ? err.message : err}`);
  }

  // 5. WebSocket (brief test — subscribe and wait 5 seconds)
  try {
    let priceCount = 0;
    await adapter.subscribeToPrices((_asset: string, _price: number) => {
      priceCount++;
    });

    await new Promise(resolve => setTimeout(resolve, 5000));

    if (priceCount > 0) {
      record('WebSocket', 'pass', `Received ${priceCount} price updates in 5s`);
    } else {
      record('WebSocket', 'warn', 'Connected but no price updates in 5s');
    }
  } catch (err) {
    record('WebSocket', 'fail', `${err instanceof Error ? err.message : err}`);
  }

  await adapter.disconnect();
}

async function testArbitrum(): Promise<void> {
  console.log('\n=== Arbitrum Sepolia ===\n');

  const rpcUrl = process.env.ARGUS_TESTNET === 'true'
    ? RPC_CONFIG.arbitrum.testnet.url
    : RPC_CONFIG.arbitrum.primary;
  const chainId = process.env.ARGUS_TESTNET === 'true'
    ? RPC_CONFIG.arbitrum.testnet.chainId
    : RPC_CONFIG.arbitrum.chainId;

  // 1. Connect to RPC
  try {
    const provider = new JsonRpcProvider(rpcUrl, chainId);
    const network = await provider.getNetwork();
    record('RPC Connection', 'pass', `Chain ID: ${network.chainId} (${rpcUrl})`);

    // 2. Get latest block
    const block = await provider.getBlockNumber();
    record('Latest Block', 'pass', `#${block}`);

    // 3. Get gas price
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice
      ? `${formatUnits(feeData.gasPrice, 'gwei')} gwei`
      : 'N/A';
    record('Gas Price', 'pass', gasPrice);
  } catch (err) {
    record('RPC Connection', 'fail', `${err instanceof Error ? err.message : err}`);
  }
}

async function testYieldAPIs(): Promise<void> {
  console.log('\n=== Yield Data APIs ===\n');

  // 1. DeFi Llama sUSDe
  try {
    const response = await fetch(
      'https://yields.llama.fi/chart/747c1d2a-c668-4571-b9c6-35b9f6a63c55',
      { signal: AbortSignal.timeout(10_000) },
    );
    if (response.ok) {
      const data = await response.json() as any;
      const chartData = data?.data ?? data?.chart ?? [];
      const latest = chartData[chartData.length - 1];
      const apy = latest?.apy ?? latest?.apyBase;
      const tvl = latest?.tvlUsd;
      const tvlStr = tvl ? `$${(tvl / 1e9).toFixed(2)}B` : 'N/A';
      record('DeFi Llama sUSDe', 'pass', `APY: ${apy?.toFixed(2) ?? 'N/A'}%, TVL: ${tvlStr}`);
    } else {
      record('DeFi Llama sUSDe', 'fail', `HTTP ${response.status}`);
    }
  } catch (err) {
    record('DeFi Llama sUSDe', 'fail', `${err instanceof Error ? err.message : err}`);
  }

  // 2. DeFi Llama USDY
  try {
    const response = await fetch(
      'https://yields.llama.fi/chart/c0e1b1b6-deb0-4970-ae6e-0fc4c0e47b8e',
      { signal: AbortSignal.timeout(10_000) },
    );
    if (response.ok) {
      const data = await response.json() as any;
      const chartData = data?.data ?? data?.chart ?? [];
      const latest = chartData[chartData.length - 1];
      const apy = latest?.apy ?? latest?.apyBase;
      record('DeFi Llama USDY', 'pass', `APY: ${apy?.toFixed(2) ?? 'N/A'}%`);
    } else {
      record('DeFi Llama USDY', 'fail', `HTTP ${response.status}`);
    }
  } catch (err) {
    record('DeFi Llama USDY', 'fail', `${err instanceof Error ? err.message : err}`);
  }

  // 3. Ethena API
  try {
    const response = await fetch(
      'https://ethena.fi/api/yields/protocol-and-staking-yield',
      { signal: AbortSignal.timeout(10_000) },
    );
    if (response.ok) {
      const data = await response.json() as any;
      // Ethena returns various yield fields — try to find the numeric one
      let yieldStr = 'unknown format';
      if (typeof data?.stakingYield === 'number') {
        yieldStr = `${data.stakingYield.toFixed(2)}%`;
      } else if (typeof data?.protocolYield === 'number') {
        yieldStr = `${data.protocolYield.toFixed(2)}%`;
      } else {
        yieldStr = `response keys: ${Object.keys(data).join(', ')}`;
      }
      record('Ethena API', 'pass', `Staking yield: ${yieldStr}`);
    } else {
      record('Ethena API', response.status === 403 ? 'warn' : 'fail',
        `HTTP ${response.status} (may require API key)`);
    }
  } catch (err) {
    record('Ethena API', 'warn', `${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     ARGUS CONNECTIVITY TEST            ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`  Testnet: ${process.env.ARGUS_TESTNET === 'true' ? 'YES' : 'NO'}`);

  await testHyperliquid();
  await testArbitrum();
  await testYieldAPIs();

  // Summary
  console.log('\n=== Summary ===\n');

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const warned = results.filter(r => r.status === 'warn').length;

  console.log(`  Total: ${results.length} | ${PASS} ${passed} | ${FAIL} ${failed} | ${WARN} ${warned}`);

  if (failed > 0) {
    console.log('\n  Failed tests:');
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`    ${FAIL} ${r.name}: ${r.detail}`);
    }
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
