/**
 * Argus Trading System — Stock Strategist (LLM-Driven Quarterly Rebalancing)
 *
 * Uses Claude to analyze:
 * - Current Ondo equity positions (from DB)
 * - Recent financial news (from news monitor)
 * - Market conditions and sector performance
 *
 * Outputs an OndoRebalancePlan with buy/sell recommendations
 * that is sent to Mark via Telegram for manual approval.
 *
 * This is NOT automated — the plan requires explicit user approval
 * before any trades are executed.
 *
 * Cadence: Quarterly (or on-demand via Telegram command).
 */

import type { OndoEquityPosition, OndoRebalancePlan } from '../lib/types.js';
import { queryClaude } from '../lib/brain.js';
import { getDb } from '../lib/db.js';
import { STRATEGY_CONFIG, ALERT_CONFIG } from '../lib/config.js';

// ─── System Prompt ──────────────────────────────────────────────────────────

const STOCK_STRATEGIST_SYSTEM_PROMPT = `You are a conservative equity strategist for a small portfolio of tokenized US stocks (via Ondo Global Markets).

Your role:
- Analyze current holdings and recent market news
- Recommend quarterly rebalancing actions
- Focus on long-term, diversified positions across sectors
- Minimize transaction costs (each trade has Ethereum L1 gas fees)

Target portfolio:
- 4-6 positions across different sectors
- No single position >30% of equity allocation
- Prefer large-cap, liquid names
- Available tokens: TSLAon, NVDAon, SPYon, QQQon (and any others on Ondo GM)

Output format (strict JSON):
{
  "buys": [{ "symbol": "string", "quantity": number, "estimatedCost": number }],
  "sells": [{ "symbol": "string", "quantity": number, "estimatedProceeds": number }],
  "rationale": "string (2-3 sentences explaining the rebalancing logic)",
  "estimatedGasCost": number
}

Important:
- Be conservative — only recommend changes with clear rationale
- Consider gas costs (~$5-15 per L1 transaction)
- If no rebalancing is needed, return empty buys/sells arrays with rationale explaining why
- Never recommend more than 3 trades in a single rebalancing`;

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Run the LLM-driven stock analysis.
 *
 * 1. Reads current Ondo equity positions from DB
 * 2. Reads recent news headlines from DB
 * 3. Calls Claude with the stock-strategist system prompt
 * 4. Parses the response into an OndoRebalancePlan
 * 5. Returns the plan (caller is responsible for sending to Telegram)
 *
 * @returns The rebalancing plan (with approvedByUser = false)
 *
 * TODO: Read positions from positions table (protocol = 'ondo' or 'ondo-gm')
 * TODO: Read recent news from news table via getRecentNews()
 * TODO: Format context for the LLM prompt
 * TODO: Parse JSON response and validate structure
 */
export async function runStockAnalysis(): Promise<OndoRebalancePlan> {
  const db = getDb();

  // 1. Get current Ondo positions from DB
  const positions = db.prepare(`
    SELECT asset, side, size, entry_price, current_price, unrealized_pnl
    FROM positions
    WHERE protocol IN ('ondo', 'ondo-gm')
  `).all() as Array<{
    asset: string;
    side: string;
    size: number;
    entry_price: number;
    current_price: number | null;
    unrealized_pnl: number | null;
  }>;

  const positionsSummary = positions.length > 0
    ? positions.map((p) =>
        `${p.asset}: ${p.size} units @ $${p.entry_price} (current: $${p.current_price ?? 'unknown'}, PnL: $${p.unrealized_pnl ?? 'unknown'})`,
      ).join('\n')
    : 'No current equity positions.';

  // 2. Get recent news
  // TODO: Import and call getRecentNews() from monitors/news.ts
  // For now, provide a placeholder
  const recentNewsSummary = '[News data not yet available — news monitor integration pending]';

  // 3. Build the prompt
  const prompt = `## Current Ondo Equity Holdings

${positionsSummary}

## Target Symbols
${STRATEGY_CONFIG['ondo-equities'].targetSymbols.join(', ')}

## Recent Financial News (Last 7 Days)
${recentNewsSummary}

## Task
Analyze the current portfolio and recent news. Recommend any rebalancing actions for this quarter. Output your response as the JSON format specified in your instructions.`;

  // 4. Call Claude
  console.error('[stock-strategist] Querying Claude for rebalancing analysis...');

  const response = await queryClaude(prompt, {
    systemPrompt: STOCK_STRATEGIST_SYSTEM_PROMPT,
    model: 'claude-opus-4-6',
    timeoutMs: 60_000,
  });

  if (response.is_error) {
    throw new Error(`Stock strategist LLM call failed: ${response.result}`);
  }

  // 5. Parse response
  const plan = parseRebalancePlan(response.result);

  console.error(
    `[stock-strategist] Analysis complete — ${plan.buys.length} buys, ${plan.sells.length} sells`,
  );
  console.error(`[stock-strategist] Rationale: ${plan.rationale}`);

  return plan;
}

// ─── Response Parsing ───────────────────────────────────────────────────────

/**
 * Parse the Claude response into an OndoRebalancePlan.
 *
 * Extracts JSON from the response (handles markdown code blocks).
 * Validates required fields are present.
 *
 * @param response - Raw Claude response text
 * @returns Parsed rebalancing plan
 */
function parseRebalancePlan(response: string): OndoRebalancePlan {
  // Extract JSON from markdown code blocks if present
  let jsonStr = response;
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse stock strategist response as JSON: ${response.slice(0, 200)}`);
  }

  const plan = parsed as Record<string, unknown>;

  // Validate structure
  if (!Array.isArray(plan.buys)) {
    throw new Error('Invalid plan: missing "buys" array');
  }
  if (!Array.isArray(plan.sells)) {
    throw new Error('Invalid plan: missing "sells" array');
  }
  if (typeof plan.rationale !== 'string') {
    throw new Error('Invalid plan: missing "rationale" string');
  }

  return {
    buys: plan.buys as OndoRebalancePlan['buys'],
    sells: plan.sells as OndoRebalancePlan['sells'],
    rationale: plan.rationale as string,
    estimatedGasCost: (plan.estimatedGasCost as number) ?? 0,
    approvedByUser: false,
  };
}

// ─── Telegram Formatting ────────────────────────────────────────────────────

/**
 * Format the rebalancing plan for Telegram display.
 *
 * @param plan - The rebalancing plan to format
 * @returns Formatted string for Telegram message
 */
export function formatPlanForTelegram(plan: OndoRebalancePlan): string {
  const lines = [
    'Ondo Equity Rebalancing Plan',
    ''.padEnd(30, '\u2500'),
    '',
  ];

  if (plan.buys.length > 0) {
    lines.push('BUY:');
    for (const buy of plan.buys) {
      lines.push(`  + ${buy.quantity} ${buy.symbol} (~$${buy.estimatedCost.toFixed(0)})`);
    }
    lines.push('');
  }

  if (plan.sells.length > 0) {
    lines.push('SELL:');
    for (const sell of plan.sells) {
      lines.push(`  - ${sell.quantity} ${sell.symbol} (~$${sell.estimatedProceeds.toFixed(0)})`);
    }
    lines.push('');
  }

  if (plan.buys.length === 0 && plan.sells.length === 0) {
    lines.push('No trades recommended this quarter.');
    lines.push('');
  }

  lines.push(`Rationale: ${plan.rationale}`);
  lines.push(`Est. gas: ~$${plan.estimatedGasCost.toFixed(0)}`);
  lines.push('');
  lines.push('Reply /approve to execute or /reject to discard.');

  return lines.join('\n');
}
