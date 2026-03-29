/**
 * Argus Trading System — Ondo Global Markets Adapter (Ethereum L1)
 *
 * Handles minting/redeeming tokenized equities via Ondo Global Markets
 * on Ethereum mainnet. Supports:
 * - TSLAon, NVDAon, SPYon, QQQon (tokenized stocks/ETFs)
 * - Chainlink price feed integration
 * - Portfolio valuation
 *
 * NOTE: Ondo equities strategy is DISABLED by default (requires manual
 * account verification before use). See STRATEGY_CONFIG['ondo-equities'].
 */

import type { OndoEquityPosition } from '../lib/types.js';
import {
  CONTRACT_ALLOWLIST,
  RPC_CONFIG,
  IS_TESTNET,
} from '../lib/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MintResult {
  txHash: string;
  quantity: number;
}

interface RedeemResult {
  txHash: string;
  usdAmount: number;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Ondo Global Markets adapter for tokenized equities.
 *
 * Operates on Ethereum L1 (not Arbitrum). Minting requires USDC deposit,
 * redeeming returns USDC. Prices sourced from Chainlink oracles.
 *
 * Gas costs are significant on L1 — all transactions should check
 * gas price against SAFETY_LIMITS.MAX_GAS_GWEI first.
 */
export class OndoAdapter {
  private readonly rpcUrl: string;
  private readonly chainId: number;
  private connected = false;

  constructor() {
    if (IS_TESTNET) {
      this.rpcUrl = RPC_CONFIG.ethereum.testnet.url;
      this.chainId = RPC_CONFIG.ethereum.testnet.chainId;
    } else {
      this.rpcUrl = RPC_CONFIG.ethereum.primary;
      this.chainId = RPC_CONFIG.ethereum.chainId;
    }
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  /**
   * Connect to Ethereum L1 RPC.
   *
   * TODO: Initialize ethers/viem provider for Ethereum mainnet
   * TODO: Verify chain ID matches expected (1 for mainnet, 11155111 for Sepolia)
   * TODO: Set up wallet signer from env private key
   */
  async connect(): Promise<void> {
    console.error(`[OndoAdapter] Connecting to ${this.rpcUrl} (chainId=${this.chainId})`);
    throw new Error('Not implemented: Ethereum L1 RPC connection');
  }

  /**
   * Whether the adapter is currently connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  // ─── Minting & Redeeming ──────────────────────────────────────────────────

  /**
   * Mint tokenized equity by depositing USDC.
   *
   * @param symbol - Equity token symbol (e.g. 'TSLAon', 'NVDAon')
   * @param usdcAmount - Amount of USDC to deposit for minting
   * @returns Transaction hash and quantity of tokens minted
   *
   * TODO: Resolve symbol to Ondo contract address
   * TODO: Approve USDC spending if needed
   * TODO: Call mint function on Ondo token contract
   * TODO: Parse event logs for minted quantity
   * TODO: Check gas price before submitting
   */
  async mintEquity(symbol: string, usdcAmount: string): Promise<MintResult> {
    console.error(`[OndoAdapter] mintEquity: ${usdcAmount} USDC → ${symbol}`);
    throw new Error('Not implemented: Ondo equity minting');
  }

  /**
   * Redeem tokenized equity back to USDC.
   *
   * @param symbol - Equity token symbol
   * @param quantity - Number of tokens to redeem
   * @returns Transaction hash and USD amount received
   *
   * TODO: Resolve symbol to Ondo contract address
   * TODO: Approve token spending if needed
   * TODO: Call redeem function on Ondo token contract
   * TODO: Parse event logs for USDC received
   * TODO: Check gas price before submitting
   */
  async redeemEquity(symbol: string, quantity: number): Promise<RedeemResult> {
    console.error(`[OndoAdapter] redeemEquity: ${quantity} ${symbol} → USDC`);
    throw new Error('Not implemented: Ondo equity redemption');
  }

  // ─── Position & Price Queries ─────────────────────────────────────────────

  /**
   * Get all Ondo equity positions (current holdings).
   *
   * Queries on-chain balances for all configured equity tokens
   * (STRATEGY_CONFIG['ondo-equities'].targetSymbols) and enriches
   * with Chainlink price data for valuation.
   *
   * @returns Array of equity positions with prices and PnL
   *
   * TODO: For each target symbol, query token balance
   * TODO: Get Chainlink price for each
   * TODO: Calculate value and PnL vs cost basis from DB
   */
  async getPositions(): Promise<OndoEquityPosition[]> {
    throw new Error('Not implemented: Ondo get positions');
  }

  /**
   * Get the Chainlink oracle price for a tokenized equity.
   *
   * @param symbol - Equity token symbol (e.g. 'TSLAon')
   * @returns Current price in USD
   *
   * TODO: Map symbol to Chainlink price feed address
   * TODO: Call latestRoundData() on the Chainlink aggregator
   * TODO: Parse answer and scale by decimals
   */
  async getChainlinkPrice(symbol: string): Promise<number> {
    console.error(`[OndoAdapter] getChainlinkPrice: ${symbol}`);
    throw new Error('Not implemented: Chainlink price query');
  }

  /**
   * Get total portfolio value of all Ondo equity holdings.
   *
   * Sums up (quantity * chainlinkPrice) for all positions.
   *
   * @returns Total portfolio value in USD
   *
   * TODO: Get all positions via getPositions()
   * TODO: Sum up value field
   */
  async getPortfolioValue(): Promise<number> {
    throw new Error('Not implemented: Ondo portfolio valuation');
  }
}
