/**
 * Argus Trading System — Type Definitions
 */

// ─── Strategy ──────────────────────────────────────────────────────────────

export type StrategyId = 'funding-rate' | 'yield' | 'reserve' | 'ondo-equities';
export type StrategyStatus = 'active' | 'paused' | 'halted' | 'error';

export interface Strategy {
  id: StrategyId;
  status: StrategyStatus;
  allocationPct: number;
  currentValue: number;
  totalPnl: number;
  updatedAt: string;
}

// ─── Positions ─────────────────────────────────────────────────────────────

export type PositionSide = 'long' | 'short' | 'supply' | 'stake';
export type Protocol = 'hyperliquid' | 'aave-v3' | 'ethena' | 'ondo' | 'ondo-gm' | 'wallet';

export interface Position {
  id: number;
  strategy: StrategyId;
  asset: string;
  protocol: Protocol;
  side: PositionSide;
  size: number;
  entryPrice: number;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  openedAt: string;
  updatedAt: string;
}

// ─── Trade WAL ─────────────────────────────────────────────────────────────

export type TradeStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';
export type TradeDirection = 'buy' | 'sell' | 'supply' | 'withdraw' | 'stake' | 'unstake' | 'mint' | 'redeem';

export interface TradeWalEntry {
  id: number;
  createdAt: string;
  strategy: StrategyId;
  asset: string;
  protocol: Protocol;
  direction: TradeDirection;
  size: string;
  intentPrice: string;
  status: TradeStatus;
  txHash: string | null;
  fillPrice: string | null;
  fillSize: string | null;
  error: string | null;
  confirmedAt: string | null;
}

// ─── Market Data ───────────────────────────────────────────────────────────

export interface FundingRate {
  id: number;
  timestamp: string;
  asset: string;
  exchange: string;
  rate: number;
  annualized: number;
}

export interface YieldData {
  id: number;
  timestamp: string;
  protocol: string;
  asset: string;
  apy: number;
  tvl: number | null;
}

export interface PriceData {
  id: number;
  timestamp: string;
  asset: string;
  price: number;
  source: string;
}

// ─── Performance ───────────────────────────────────────────────────────────

export interface StrategyPerformance {
  id: number;
  date: string;
  strategy: StrategyId;
  dailyPnl: number | null;
  totalPnl: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
}

// ─── Funding Rate Arb ──────────────────────────────────────────────────────

export type FundingSignal = 'enter' | 'exit' | 'hold' | 'rebalance';

export interface FundingArbState {
  isActive: boolean;
  spotAsset: string;
  spotSize: number;
  perpSize: number;
  spotChain: 'arbitrum';
  perpExchange: 'hyperliquid';
  entryFundingRate: number;
  currentFundingRate: number;
  collectedFunding: number;
  basisDivergence: number;
  effectiveLeverage: number;
  marginRatio: number;
}

export interface FundingEntrySignal {
  type: 'enter';
  asset: string;
  fundingRate8h: number;
  annualizedRate: number;
  openInterest: number;
  spotPrice: number;
  perpPrice: number;
  recommendedSize: number;
}

export interface FundingExitSignal {
  type: 'exit';
  reason: 'negative_funding' | 'low_rate' | 'basis_divergence' | 'circuit_breaker';
  currentRate: number;
  basisDivergence: number;
}

// ─── Yield Strategy ────────────────────────────────────────────────────────

export type YieldSignal = 'rebalance' | 'emergency_exit' | 'hold';

export interface YieldAllocation {
  protocol: Protocol;
  asset: string;
  amount: number;
  currentApy: number;
  healthFactor: number | null;
}

export interface YieldRebalanceSignal {
  type: 'rebalance';
  from: { protocol: Protocol; asset: string; amount: number };
  to: { protocol: Protocol; asset: string; amount: number };
  yieldDifferential: number;
  estimatedGasCost: number;
  estimatedMonthlyGain: number;
}

// ─── Execution ─────────────────────────────────────────────────────────────

export interface OrderParams {
  asset: string;
  side: 'buy' | 'sell';
  size: number;
  price?: number; // undefined = market order
  reduceOnly?: boolean;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  txHash?: string;
  fillPrice?: number;
  fillSize?: number;
  error?: string;
}

export interface HyperliquidPosition {
  asset: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  marginUsed: number;
  liquidationPrice: number;
}

export interface HyperliquidFundingPayment {
  timestamp: string;
  asset: string;
  amount: number;
  rate: number;
}

// ─── Arbitrum DeFi ─────────────────────────────────────────────────────────

export interface AavePosition {
  asset: string;
  supplied: number;
  borrowed: number;
  supplyApy: number;
  borrowApy: number;
  healthFactor: number;
}

export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  maxSlippagePct: number;
}

export interface SwapResult {
  success: boolean;
  txHash?: string;
  amountOut?: string;
  effectivePrice?: number;
  slippage?: number;
  error?: string;
}

// ─── Ondo Global Markets ───────────────────────────────────────────────────

export interface OndoEquityPosition {
  symbol: string;       // e.g., 'TSLAon', 'NVDAon'
  quantity: number;
  chainlinkPrice: number;
  value: number;
  costBasis: number;
  unrealizedPnl: number;
}

export interface OndoRebalancePlan {
  buys: Array<{ symbol: string; quantity: number; estimatedCost: number }>;
  sells: Array<{ symbol: string; quantity: number; estimatedProceeds: number }>;
  rationale: string;
  estimatedGasCost: number;
  approvedByUser: boolean;
}

// ─── Circuit Breakers ──────────────────────────────────────────────────────

export type CircuitBreakerLevel = 'warning' | 'halt' | 'emergency';

export interface CircuitBreakerEvent {
  level: CircuitBreakerLevel;
  strategy: StrategyId | 'portfolio';
  trigger: string;
  value: number;
  threshold: number;
  action: string;
  timestamp: string;
}

// ─── Kill Switch ───────────────────────────────────────────────────────────

export interface KillSwitchResult {
  cancelledOrders: number;
  closedPositions: number;
  withdrawnSupply: number;
  haltedStrategies: string[];
  errors: string[];
  executionTimeMs: number;
}

// ─── Reconciliation ────────────────────────────────────────────────────────

export interface ReconciliationResult {
  timestamp: string;
  discrepancies: Discrepancy[];
  isClean: boolean;
}

export interface Discrepancy {
  type: 'position_mismatch' | 'balance_mismatch' | 'orphan_order' | 'wal_stuck';
  protocol: Protocol;
  asset: string;
  expected: string;
  actual: string;
  severity: 'info' | 'warning' | 'critical';
}

// ─── Alerts ────────────────────────────────────────────────────────────────

export type AlertChannel = 'telegram' | 'pushover' | 'email';
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'emergency';

export interface Alert {
  severity: AlertSeverity;
  title: string;
  message: string;
  channels: AlertChannel[];
  timestamp: string;
}

// ─── Config ────────────────────────────────────────────────────────────────

export interface ArgusConfig {
  safetyLimits: typeof import('./config.js').SAFETY_LIMITS;
  contractAllowlist: typeof import('./config.js').CONTRACT_ALLOWLIST;
  strategies: Record<StrategyId, { enabled: boolean; allocationPct: number }>;
}
