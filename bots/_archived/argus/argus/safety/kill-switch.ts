/**
 * Argus Trading System — Kill Switch
 *
 * EMERGENCY: Cancel all orders, close all positions, halt all strategies.
 * EXEMPT from MAX_GAS_GWEI and MAX_SLIPPAGE_PCT — executes regardless of cost.
 *
 * Triggered via:
 * 1. Telegram /kill command (double-tap confirmation)
 * 2. SSH script (argus-kill.sh) — independent of Telegram
 * 3. Circuit breaker emergency threshold
 *
 * Tested weekly (Sunday automated dry-run).
 */

import type { KillSwitchResult, StrategyId } from '../lib/types.js';
import { getDb } from '../lib/db.js';

interface KillSwitchDeps {
  /** Cancel all open orders on Hyperliquid */
  cancelAllOrders: () => Promise<{ cancelled: number; errors: string[] }>;
  /** Close all perp positions on Hyperliquid (market orders) */
  closeAllPerps: () => Promise<{ closed: number; errors: string[] }>;
  /** Withdraw all supplied assets from Aave */
  withdrawAllAave: () => Promise<{ withdrawn: number; errors: string[] }>;
  /** Send alert to specified channels */
  sendAlert: (severity: 'critical' | 'emergency', title: string, message: string) => Promise<void>;
}

/**
 * Execute the kill switch. This is the nuclear option.
 *
 * Order of operations:
 * 1. Cancel all open orders on Hyperliquid
 * 2. Close all perp positions on Hyperliquid (market orders)
 * 3. Initiate withdrawal from Aave
 * 4. Set all strategies to 'halted' in DB
 * 5. Send confirmation to all alert channels
 */
export async function executeKillSwitch(
  deps: KillSwitchDeps,
  options: { dryRun?: boolean } = {},
): Promise<KillSwitchResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let cancelledOrders = 0;
  let closedPositions = 0;
  let withdrawnSupply = 0;
  const haltedStrategies: string[] = [];

  const logPrefix = options.dryRun ? '[DRY-RUN] ' : '[KILL-SWITCH] ';

  console.error(`${logPrefix}KILL SWITCH ACTIVATED`);

  // Step 1: Cancel all open orders
  try {
    if (!options.dryRun) {
      const result = await deps.cancelAllOrders();
      cancelledOrders = result.cancelled;
      errors.push(...result.errors);
    }
    console.error(`${logPrefix}Cancelled ${cancelledOrders} orders`);
  } catch (err) {
    const msg = `Failed to cancel orders: ${err instanceof Error ? err.message : err}`;
    errors.push(msg);
    console.error(`${logPrefix}${msg}`);
  }

  // Step 2: Close all perp positions (market orders — accept any slippage)
  try {
    if (!options.dryRun) {
      const result = await deps.closeAllPerps();
      closedPositions = result.closed;
      errors.push(...result.errors);
    }
    console.error(`${logPrefix}Closed ${closedPositions} perp positions`);
  } catch (err) {
    const msg = `Failed to close perps: ${err instanceof Error ? err.message : err}`;
    errors.push(msg);
    console.error(`${logPrefix}${msg}`);
  }

  // Step 3: Withdraw from Aave
  try {
    if (!options.dryRun) {
      const result = await deps.withdrawAllAave();
      withdrawnSupply = result.withdrawn;
      errors.push(...result.errors);
    }
    console.error(`${logPrefix}Withdrew ${withdrawnSupply} Aave supply positions`);
  } catch (err) {
    const msg = `Failed to withdraw from Aave: ${err instanceof Error ? err.message : err}`;
    errors.push(msg);
    console.error(`${logPrefix}${msg}`);
  }

  // Step 4: Halt all strategies in DB
  try {
    const db = getDb();
    const strategies = db.prepare(
      "SELECT id FROM strategies WHERE status != 'halted'"
    ).all() as Array<{ id: string }>;

    if (!options.dryRun) {
      const haltStmt = db.prepare(
        "UPDATE strategies SET status = 'halted', updated_at = datetime('now') WHERE id = ?"
      );
      for (const s of strategies) {
        haltStmt.run(s.id);
        haltedStrategies.push(s.id);
      }
    } else {
      haltedStrategies.push(...strategies.map((s) => s.id));
    }
    console.error(`${logPrefix}Halted ${haltedStrategies.length} strategies`);
  } catch (err) {
    const msg = `Failed to halt strategies in DB: ${err instanceof Error ? err.message : err}`;
    errors.push(msg);
    console.error(`${logPrefix}${msg}`);
  }

  const executionTimeMs = Date.now() - startTime;

  const result: KillSwitchResult = {
    cancelledOrders,
    closedPositions,
    withdrawnSupply,
    haltedStrategies,
    errors,
    executionTimeMs,
  };

  // Step 5: Send alert
  const severity = errors.length > 0 ? 'emergency' : 'critical';
  const alertTitle = options.dryRun ? 'Kill Switch Dry-Run Complete' : 'KILL SWITCH ACTIVATED';
  const alertMessage = formatKillSwitchReport(result, options.dryRun ?? false);

  try {
    await deps.sendAlert(severity, alertTitle, alertMessage);
  } catch (err) {
    console.error(`${logPrefix}Failed to send alert: ${err}`);
  }

  console.error(`${logPrefix}Kill switch complete in ${executionTimeMs}ms`);
  return result;
}

/**
 * Format kill switch result for Telegram/alerts.
 */
export function formatKillSwitchReport(result: KillSwitchResult, dryRun: boolean): string {
  const prefix = dryRun ? 'DRY-RUN: ' : '';
  const lines = [
    `${prefix}Kill Switch Report`,
    `${'─'.repeat(30)}`,
    `Orders cancelled: ${result.cancelledOrders}`,
    `Positions closed: ${result.closedPositions}`,
    `Aave withdrawals: ${result.withdrawnSupply}`,
    `Strategies halted: ${result.haltedStrategies.join(', ') || 'none'}`,
    `Execution time: ${result.executionTimeMs}ms`,
  ];

  if (result.errors.length > 0) {
    lines.push('');
    lines.push('ERRORS:');
    for (const err of result.errors) {
      lines.push(`  - ${err}`);
    }
  }

  return lines.join('\n');
}

/**
 * Check if kill switch confirmation is pending for a chat.
 * Uses in-memory Map with TTL — not persisted.
 */
const pendingConfirmations = new Map<string, number>();
const CONFIRMATION_TTL_MS = 30_000; // 30 seconds

export function requestKillConfirmation(chatId: string): void {
  pendingConfirmations.set(chatId, Date.now());
}

export function confirmKill(chatId: string): boolean {
  const requestTime = pendingConfirmations.get(chatId);
  if (!requestTime) return false;

  pendingConfirmations.delete(chatId);

  if (Date.now() - requestTime > CONFIRMATION_TTL_MS) {
    return false; // Expired
  }

  return true;
}

export function cancelKillConfirmation(chatId: string): void {
  pendingConfirmations.delete(chatId);
}
