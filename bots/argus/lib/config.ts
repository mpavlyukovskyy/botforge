/**
 * Argus Trading System — Configuration & Safety Limits
 *
 * All hardcoded limits and contract addresses live here.
 * These values are the last line of defense — they MUST NOT be overridable by config.
 */

// ─── Safety Limits (hardcoded, non-overridable) ────────────────────────────

export const SAFETY_LIMITS = {
  // Per-trade
  MAX_SINGLE_TRADE_PCT: 0.03,       // 3% of strategy allocation

  // Funding rate arb
  MAX_FUNDING_LEVERAGE: 2,
  MIN_FUNDING_ANNUALIZED: 0.10,     // Don't enter below 10% annualized
  MAX_BASIS_DIVERGENCE: 0.02,       // Close if spot/perp diverge > 2%
  MIN_MARGIN_RATIO: 0.40,           // Maintain 40%+ margin
  FUNDING_ENTRY_MIN_PERIODS: 3,     // Must be elevated for 3+ consecutive 8h periods
  FUNDING_ENTRY_MIN_OI: 50_000_000, // $50M minimum open interest
  FUNDING_EXIT_NEGATIVE_PERIODS: 2, // Exit after 2 consecutive negative periods
  FUNDING_EXIT_MIN_ANNUALIZED: 0.05, // Exit below 5% annualized
  REBALANCE_MAX_LEVERAGE: 2.5,      // Rebalance if leverage exceeds this
  REBALANCE_MIN_LEVERAGE: 1.6,      // Rebalance if leverage drops below this

  // Yield
  MAX_SINGLE_PROTOCOL_PCT: 0.30,    // 30% max in any protocol
  MIN_HEALTH_FACTOR: 2.0,           // Conservative Aave health factor
  NO_YIELD_LOOPING_V1: true,        // Disabled until v1.5
  YIELD_REBALANCE_MIN_DIFFERENTIAL: 0.02, // 2% yield differential to trigger rebalance
  SUSDE_DEPEG_THRESHOLD: 0.005,     // 0.5% depeg triggers emergency exit

  // Global
  MIN_CASH_RESERVE: 0.20,           // 20% always liquid
  MAX_TRADES_PER_HOUR: 5,
  MAX_TRADES_PER_DAY: 20,
  MAX_GAS_GWEI: 50,                 // For L1 fallback
  MAX_SLIPPAGE_PCT: 0.003,          // 0.3% max slippage (routine)
  EMERGENCY_SLIPPAGE_TIERS: [0.003, 0.01, 0.03] as readonly number[],

  // Circuit breakers
  PORTFOLIO_WARNING_DRAWDOWN: 0.05,  // 5% drawdown → warning
  PORTFOLIO_HALT_DRAWDOWN: 0.08,     // 8% drawdown → halt all
  STRATEGY_HALT_DRAWDOWN: 0.05,      // 5% per-strategy → halt that strategy
  MAX_CONSECUTIVE_RPC_ERRORS: 3,     // Switch to backup RPC after 3 failures

  // Kill switch is EXEMPT from MAX_GAS_GWEI and MAX_SLIPPAGE_PCT
  KILL_SWITCH_EXEMPT: true,
} as const;

// ─── Contract Allowlist (Arbitrum) ─────────────────────────────────────────
// All DeFi interactions validate target address against this allowlist.
// NEVER add addresses without manual verification on block explorer.

export const CONTRACT_ALLOWLIST = {
  arbitrum: {
    // Tokens
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',   // Native USDC
    USDC_BRIDGED: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // Bridged USDC.e
    SUSDE: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2',    // sUSDe on Arbitrum
    USDE: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',     // USDe on Arbitrum
    USDY: '0x35e050d3C0eC2d29D269a8EcEa763a183bDF9A9D',     // USDY on Arbitrum

    // Aave V3
    AAVE_POOL: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    AAVE_POOL_DATA_PROVIDER: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',

    // Uniswap V3
    UNISWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    UNISWAP_QUOTER: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',

    // Chainlink Price Feeds (Arbitrum)
    CHAINLINK_ETH_USD: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    CHAINLINK_USDC_USD: '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    CHAINLINK_BTC_USD: '0x6ce185860a4963106506C203335A2910413708e9',
  },

  ethereum: {
    // Ondo Global Markets (Ethereum L1)
    // NOTE: These are placeholder addresses — verify on Ondo docs before use
    ONDO_TOKEN: '0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3',
    USDY_L1: '0x96F6eF951840721AdBF46Ac996b59E0235CB985C',

    // Chainlink feeds (Ethereum mainnet)
    CHAINLINK_ETH_USD: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  },
} as const;

// ─── Strategy Configuration ────────────────────────────────────────────────

export const STRATEGY_CONFIG = {
  'funding-rate': {
    enabled: true,
    allocationPct: 0.40,
    assets: ['ETH', 'BTC', 'SOL'],
    // Split: 50% spot (Arbitrum WETH), 25% perp margin (Hyperliquid USDC), 25% buffer
    spotPct: 0.50,
    marginPct: 0.25,
    bufferPct: 0.25,
  },
  'yield': {
    enabled: true,
    allocationPct: 0.40,
    staticPct: 0.40,   // USDY
    activePct: 0.60,   // sUSDe + Aave
  },
  'reserve': {
    enabled: true,
    allocationPct: 0.20,
  },
  'ondo-equities': {
    enabled: false, // Requires manual account verification first
    targetSymbols: ['TSLAon', 'NVDAon', 'SPYon', 'QQQon'],
  },
} as const;

// ─── RPC Configuration ────────────────────────────────────────────────────

export const RPC_CONFIG = {
  arbitrum: {
    primary: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    fallback: process.env.ARBITRUM_RPC_FALLBACK || 'https://arbitrum.llamarpc.com',
    chainId: 42161,
    testnet: {
      url: process.env.ARBITRUM_TESTNET_RPC || 'https://sepolia-rollup.arbitrum.io/rpc',
      chainId: 421614,
    },
  },
  ethereum: {
    primary: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
    fallback: process.env.ETHEREUM_RPC_FALLBACK || 'https://rpc.ankr.com/eth',
    chainId: 1,
    testnet: {
      url: process.env.ETHEREUM_TESTNET_RPC || 'https://rpc.sepolia.org',
      chainId: 11155111,
    },
  },
  hyperliquid: {
    mainnet: 'https://api.hyperliquid.xyz',
    testnet: 'https://api.hyperliquid-testnet.xyz',
    ws: {
      mainnet: 'wss://api.hyperliquid.xyz/ws',
      testnet: 'wss://api.hyperliquid-testnet.xyz/ws',
    },
  },
} as const;

// ─── Alert Configuration ───────────────────────────────────────────────────

export const ALERT_CONFIG = {
  telegramChatId: '381823289',
  // Pushover keys loaded from env
  pushoverUserKey: process.env.PUSHOVER_USER_KEY || '',
  pushoverAppToken: process.env.PUSHOVER_APP_TOKEN || '',
  // Healthchecks.io
  healthchecksPingUrl: process.env.HEALTHCHECKS_PING_URL || '',
  // Severity → channel mapping
  channelMap: {
    info: ['telegram'] as const,
    warning: ['telegram'] as const,
    critical: ['telegram', 'pushover'] as const,
    emergency: ['telegram', 'pushover'] as const,
  },
} as const;

// ─── Database Configuration ────────────────────────────────────────────────

export const DB_CONFIG = {
  path: process.env.ARGUS_DB_PATH || 'data/argus.db',
  walMode: true,
  synchronousFull: true,   // For trade_wal — no data loss on power failure
  busyTimeout: 30_000,     // 30 seconds
  backupDir: process.env.ARGUS_BACKUP_DIR || 'data/backups',
} as const;

// ─── Testnet Mode ──────────────────────────────────────────────────────────

export const IS_TESTNET = process.env.ARGUS_TESTNET === 'true';
export const IS_PAPER_TRADING = process.env.ARGUS_PAPER_TRADING === 'true';

/**
 * Validate a contract address against the allowlist.
 * Returns true if the address is on the allowlist for the given chain.
 */
export function isAllowlistedAddress(chain: 'arbitrum' | 'ethereum', address: string): boolean {
  const allowlist = CONTRACT_ALLOWLIST[chain];
  if (!allowlist) return false;
  const normalizedAddress = address.toLowerCase();
  return Object.values(allowlist).some(
    (addr) => addr.toLowerCase() === normalizedAddress
  );
}
