/**
 * Argus Trading System — Reconciliation Engine
 *
 * Runs on EVERY startup AND every 30 minutes:
 * 1. Query Hyperliquid for open positions and orders
 * 2. Query Arbitrum for token balances
 * 3. Compare against local DB
 * 4. If discrepancy: log alert, send notification, do NOT auto-correct
 *
 * Human reviews all discrepancies. Automated correction is too dangerous.
 */

import type { Discrepancy, ReconciliationResult, Protocol } from '../lib/types.js';
import { getDb } from '../lib/db.js';
import { getIncompleteTradeEntries } from './trade-wal.js';

interface ReconciliationDeps {
  /** Get all open positions on Hyperliquid */
  getHyperliquidPositions: () => Promise<Array<{
    asset: string;
    size: number;
    entryPrice: number;
  }>>;
  /** Get all open orders on Hyperliquid */
  getHyperliquidOpenOrders: () => Promise<Array<{
    asset: string;
    side: string;
    size: number;
    price: number;
  }>>;
  /** Get token balances on Arbitrum */
  getArbitrumBalances: () => Promise<Array<{
    token: string;
    balance: number;
  }>>;
  /** Get Aave supply positions */
  getAavePositions: () => Promise<Array<{
    asset: string;
    supplied: number;
    healthFactor: number;
  }>>;
  /** Send alert */
  sendAlert: (severity: 'warning' | 'critical', title: string, message: string) => Promise<void>;
}

/**
 * Run full reconciliation check.
 */
export async function runReconciliation(deps: ReconciliationDeps): Promise<ReconciliationResult> {
  const timestamp = new Date().toISOString();
  const discrepancies: Discrepancy[] = [];
  const db = getDb();

  // 1. Check for stuck WAL entries
  const incompleteWal = getIncompleteTradeEntries();
  for (const entry of incompleteWal) {
    const ageMinutes = (Date.now() - new Date(entry.createdAt).getTime()) / 60_000;

    // Trades should complete within 5 minutes. Older entries are suspicious.
    if (ageMinutes > 5) {
      discrepancies.push({
        type: 'wal_stuck',
        protocol: entry.protocol as Protocol,
        asset: entry.asset,
        expected: `Status: confirmed or failed (after ${Math.round(ageMinutes)}min)`,
        actual: `Status: ${entry.status}`,
        severity: ageMinutes > 30 ? 'critical' : 'warning',
      });
    }
  }

  // 2. Reconcile Hyperliquid positions
  try {
    const hlPositions = await deps.getHyperliquidPositions();
    const dbPositions = db.prepare(`
      SELECT asset, side, size FROM positions
      WHERE protocol = 'hyperliquid' AND side IN ('long', 'short')
    `).all() as Array<{ asset: string; side: string; size: number }>;

    // Check for positions on exchange not in DB
    for (const hlPos of hlPositions) {
      const dbMatch = dbPositions.find(
        (p) => p.asset === hlPos.asset
      );
      if (!dbMatch) {
        discrepancies.push({
          type: 'position_mismatch',
          protocol: 'hyperliquid',
          asset: hlPos.asset,
          expected: 'No position in DB',
          actual: `Size: ${hlPos.size} @ ${hlPos.entryPrice}`,
          severity: 'critical',
        });
      } else if (Math.abs(dbMatch.size - Math.abs(hlPos.size)) / Math.abs(hlPos.size) > 0.01) {
        // Size mismatch > 1%
        discrepancies.push({
          type: 'position_mismatch',
          protocol: 'hyperliquid',
          asset: hlPos.asset,
          expected: `DB size: ${dbMatch.size}`,
          actual: `Exchange size: ${Math.abs(hlPos.size)}`,
          severity: 'warning',
        });
      }
    }

    // Check for positions in DB not on exchange
    for (const dbPos of dbPositions) {
      const hlMatch = hlPositions.find((p) => p.asset === dbPos.asset);
      if (!hlMatch) {
        discrepancies.push({
          type: 'position_mismatch',
          protocol: 'hyperliquid',
          asset: dbPos.asset,
          expected: `DB has position: ${dbPos.side} ${dbPos.size}`,
          actual: 'No position on exchange',
          severity: 'critical',
        });
      }
    }
  } catch (err) {
    discrepancies.push({
      type: 'position_mismatch',
      protocol: 'hyperliquid',
      asset: 'ALL',
      expected: 'Reconciliation check',
      actual: `Error querying Hyperliquid: ${err instanceof Error ? err.message : err}`,
      severity: 'critical',
    });
  }

  // 3. Reconcile Arbitrum balances
  try {
    const arbBalances = await deps.getArbitrumBalances();
    const dbBalances = db.prepare(`
      SELECT asset, size FROM positions
      WHERE protocol = 'wallet' AND side = 'long'
    `).all() as Array<{ asset: string; size: number }>;

    for (const arb of arbBalances) {
      const dbMatch = dbBalances.find((b) => b.asset === arb.token);
      if (dbMatch && Math.abs(dbMatch.size - arb.balance) / arb.balance > 0.01) {
        discrepancies.push({
          type: 'balance_mismatch',
          protocol: 'wallet',
          asset: arb.token,
          expected: `DB: ${dbMatch.size}`,
          actual: `On-chain: ${arb.balance}`,
          severity: 'warning',
        });
      }
    }
  } catch (err) {
    discrepancies.push({
      type: 'balance_mismatch',
      protocol: 'wallet',
      asset: 'ALL',
      expected: 'Reconciliation check',
      actual: `Error querying Arbitrum: ${err instanceof Error ? err.message : err}`,
      severity: 'critical',
    });
  }

  // 4. Reconcile Aave positions
  try {
    const aavePositions = await deps.getAavePositions();
    const dbAave = db.prepare(`
      SELECT asset, size FROM positions
      WHERE protocol = 'aave-v3' AND side = 'supply'
    `).all() as Array<{ asset: string; size: number }>;

    for (const aave of aavePositions) {
      const dbMatch = dbAave.find((p) => p.asset === aave.asset);
      if (dbMatch && Math.abs(dbMatch.size - aave.supplied) / aave.supplied > 0.01) {
        discrepancies.push({
          type: 'position_mismatch',
          protocol: 'aave-v3',
          asset: aave.asset,
          expected: `DB: ${dbMatch.size}`,
          actual: `On-chain: ${aave.supplied}`,
          severity: 'warning',
        });
      }
    }
  } catch (err) {
    discrepancies.push({
      type: 'position_mismatch',
      protocol: 'aave-v3',
      asset: 'ALL',
      expected: 'Reconciliation check',
      actual: `Error querying Aave: ${err instanceof Error ? err.message : err}`,
      severity: 'critical',
    });
  }

  // 5. Log results
  const isClean = discrepancies.length === 0;
  const result: ReconciliationResult = { timestamp, discrepancies, isClean };

  // Store in DB
  db.prepare(`
    INSERT INTO reconciliation_log (timestamp, is_clean, discrepancy_count, details)
    VALUES (?, ?, ?, ?)
  `).run(
    timestamp,
    isClean ? 1 : 0,
    discrepancies.length,
    JSON.stringify(discrepancies),
  );

  // 6. Alert if discrepancies found
  if (!isClean) {
    const criticalCount = discrepancies.filter((d) => d.severity === 'critical').length;
    const severity = criticalCount > 0 ? 'critical' : 'warning';
    const title = `Reconciliation: ${discrepancies.length} discrepancies found`;
    const message = formatReconciliationReport(result);
    await deps.sendAlert(severity, title, message);
  }

  return result;
}

/**
 * Format reconciliation result for display.
 */
export function formatReconciliationReport(result: ReconciliationResult): string {
  if (result.isClean) {
    return `Reconciliation clean at ${result.timestamp}`;
  }

  const lines = [
    `Reconciliation Report — ${result.timestamp}`,
    `${'─'.repeat(40)}`,
    `Discrepancies: ${result.discrepancies.length}`,
    '',
  ];

  for (const d of result.discrepancies) {
    const icon = d.severity === 'critical' ? 'CRIT' : 'WARN';
    lines.push(`[${icon}] ${d.type} — ${d.protocol}/${d.asset}`);
    lines.push(`  Expected: ${d.expected}`);
    lines.push(`  Actual:   ${d.actual}`);
    lines.push('');
  }

  lines.push('ACTION REQUIRED: Review and resolve manually.');
  return lines.join('\n');
}
