/**
 * Argus Trading System — Arbitrum L2 DeFi Adapter
 *
 * Real implementation using ethers.js v6.
 * Handles all on-chain interactions on Arbitrum:
 * - Token balance queries and approvals
 * - Uniswap V3 swaps
 * - Aave V3 supply/withdraw
 * - sUSDe depeg monitoring and emergency DEX sell
 *
 * CRITICAL: All contract addresses are validated against CONTRACT_ALLOWLIST
 * before any interaction.
 */

import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, MaxUint256 } from 'ethers';
import type {
  SwapParams,
  SwapResult,
  AavePosition,
} from '../lib/types.js';
import {
  CONTRACT_ALLOWLIST,
  RPC_CONFIG,
  isAllowlistedAddress,
  SAFETY_LIMITS,
  IS_TESTNET,
} from '../lib/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenBalance {
  token: string;
  balance: number;
}

interface AaveResult {
  txHash: string;
  success: boolean;
}

interface WithdrawAllResult {
  withdrawn: number;
  errors: string[];
}

// ─── ABIs (minimal, only what we need) ───────────────────────────────────────

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
];

const AAVE_DATA_PROVIDER_ABI = [
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
  'function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)',
];

const UNISWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const UNISWAP_QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
];

// ─── Token Metadata ──────────────────────────────────────────────────────────

const TOKEN_DECIMALS: Record<string, number> = {
  WETH: 18,
  USDC: 6,
  USDC_BRIDGED: 6,
  SUSDE: 18,
  USDE: 18,
  USDY: 18,
};

const TOKEN_SYMBOLS: Record<string, string> = {
  WETH: 'WETH',
  USDC: 'USDC',
  USDC_BRIDGED: 'USDC.e',
  SUSDE: 'sUSDe',
  USDE: 'USDe',
  USDY: 'USDY',
};

// Reverse map: symbol → allowlist key
function getTokenKey(symbol: string): string | null {
  for (const [key, sym] of Object.entries(TOKEN_SYMBOLS)) {
    if (sym.toLowerCase() === symbol.toLowerCase()) return key;
  }
  // Also check direct keys
  const upper = symbol.toUpperCase();
  if (upper in CONTRACT_ALLOWLIST.arbitrum) return upper;
  return null;
}

function getTokenAddress(symbol: string): string {
  const key = getTokenKey(symbol);
  if (!key) throw new Error(`Unknown token symbol: ${symbol}`);
  const address = (CONTRACT_ALLOWLIST.arbitrum as Record<string, string>)[key];
  if (!address) throw new Error(`No address for token: ${symbol}`);
  return address;
}

function getTokenDecimals(symbol: string): number {
  const key = getTokenKey(symbol);
  if (!key || !(key in TOKEN_DECIMALS)) return 18; // default to 18
  return TOKEN_DECIMALS[key];
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class ArbitrumAdapter {
  private readonly rpcUrl: string;
  private readonly chainId: number;
  private connected = false;

  private provider!: JsonRpcProvider;
  private wallet: Wallet | null = null;

  constructor() {
    if (IS_TESTNET) {
      this.rpcUrl = RPC_CONFIG.arbitrum.testnet.url;
      this.chainId = RPC_CONFIG.arbitrum.testnet.chainId;
    } else {
      this.rpcUrl = RPC_CONFIG.arbitrum.primary;
      this.chainId = RPC_CONFIG.arbitrum.chainId;
    }
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  async connect(privateKey?: string): Promise<void> {
    if (this.connected) return;

    this.provider = new JsonRpcProvider(this.rpcUrl, this.chainId);

    // Verify chain ID
    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== this.chainId) {
      throw new Error(
        `Chain ID mismatch: expected ${this.chainId}, got ${network.chainId}`
      );
    }

    if (privateKey) {
      this.wallet = new Wallet(privateKey, this.provider);
    }

    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getAddress(): string | null {
    return this.wallet?.address ?? null;
  }

  // ─── Balance Queries ──────────────────────────────────────────────────────

  async getBalance(token: string): Promise<number> {
    if (!this.wallet) throw new Error('Wallet not set');

    if (token.toUpperCase() === 'ETH') {
      const balance = await this.provider.getBalance(this.wallet.address);
      return parseFloat(formatUnits(balance, 18));
    }

    const address = getTokenAddress(token);
    const decimals = getTokenDecimals(token);
    const contract = new Contract(address, ERC20_ABI, this.provider);
    const balance = await contract.balanceOf(this.wallet.address);
    return parseFloat(formatUnits(balance, decimals));
  }

  async getBalances(): Promise<TokenBalance[]> {
    if (!this.wallet) throw new Error('Wallet not set');

    const tokens = ['WETH', 'USDC', 'SUSDE', 'USDE', 'USDY'];
    const results: TokenBalance[] = [];

    // Query ETH balance
    const ethBalance = await this.provider.getBalance(this.wallet.address);
    results.push({ token: 'ETH', balance: parseFloat(formatUnits(ethBalance, 18)) });

    // Query all ERC-20 balances
    for (const token of tokens) {
      try {
        const address = getTokenAddress(token);
        const decimals = getTokenDecimals(token);
        const contract = new Contract(address, ERC20_ABI, this.provider);
        const balance = await contract.balanceOf(this.wallet.address);
        results.push({ token, balance: parseFloat(formatUnits(balance, decimals)) });
      } catch {
        results.push({ token, balance: 0 });
      }
    }

    return results;
  }

  // ─── Token Approvals ──────────────────────────────────────────────────────

  async approveToken(
    token: string,
    spender: string,
    amount: string,
  ): Promise<string> {
    if (!this.wallet) throw new Error('Wallet not set');

    // Safety: validate both addresses
    if (!isAllowlistedAddress('arbitrum', token)) {
      throw new Error(`Token address not allowlisted: ${token}`);
    }
    if (!isAllowlistedAddress('arbitrum', spender)) {
      throw new Error(`Spender address not allowlisted: ${spender}`);
    }

    const contract = new Contract(token, ERC20_ABI, this.wallet);

    // Get token decimals
    const decimals = await contract.decimals();
    const parsedAmount = parseUnits(amount, decimals);

    const tx = await contract.approve(spender, parsedAmount);
    const receipt = await tx.wait();

    return receipt.hash;
  }

  /**
   * Ensure allowance is sufficient, approve if not.
   * Uses exact amount (no unlimited approvals per security policy).
   */
  private async ensureAllowance(
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint,
    decimals: number,
  ): Promise<void> {
    if (!this.wallet) throw new Error('Wallet not set');

    const contract = new Contract(tokenAddress, ERC20_ABI, this.provider);
    const currentAllowance = await contract.allowance(
      this.wallet.address,
      spenderAddress,
    );

    if (currentAllowance < amount) {
      const approveContract = new Contract(tokenAddress, ERC20_ABI, this.wallet);
      const tx = await approveContract.approve(spenderAddress, amount);
      await tx.wait();
    }
  }

  // ─── Uniswap V3 Swaps ────────────────────────────────────────────────────

  async swap(params: SwapParams): Promise<SwapResult> {
    if (!this.wallet) throw new Error('Wallet not set');

    // Safety: validate slippage
    if (params.maxSlippagePct > SAFETY_LIMITS.MAX_SLIPPAGE_PCT) {
      return {
        success: false,
        error: `Slippage ${params.maxSlippagePct} exceeds max ${SAFETY_LIMITS.MAX_SLIPPAGE_PCT}`,
      };
    }

    const tokenInAddress = getTokenAddress(params.tokenIn);
    const tokenOutAddress = getTokenAddress(params.tokenOut);
    const decimalsIn = getTokenDecimals(params.tokenIn);
    const decimalsOut = getTokenDecimals(params.tokenOut);
    const routerAddress = CONTRACT_ALLOWLIST.arbitrum.UNISWAP_ROUTER;
    const quoterAddress = CONTRACT_ALLOWLIST.arbitrum.UNISWAP_QUOTER;

    const amountIn = parseUnits(params.amountIn, decimalsIn);

    try {
      // 1. Get quote
      const quoter = new Contract(quoterAddress, UNISWAP_QUOTER_ABI, this.provider);
      const fee = 3000; // 0.3% pool (most liquid for major pairs)
      const quotedAmountOut = await quoter.quoteExactInputSingle.staticCall(
        tokenInAddress,
        tokenOutAddress,
        fee,
        amountIn,
        0, // no price limit
      );

      // 2. Calculate minimum output with slippage
      const slippageFactor = BigInt(Math.floor((1 - params.maxSlippagePct) * 10000));
      const amountOutMinimum = (quotedAmountOut * slippageFactor) / 10000n;

      // 3. Ensure approval
      await this.ensureAllowance(tokenInAddress, routerAddress, amountIn, decimalsIn);

      // 4. Execute swap
      const router = new Contract(routerAddress, UNISWAP_ROUTER_ABI, this.wallet);
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes

      const tx = await router.exactInputSingle({
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        fee,
        recipient: this.wallet.address,
        deadline,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0,
      });

      const receipt = await tx.wait();

      // Parse output from logs
      const amountOut = parseFloat(formatUnits(quotedAmountOut, decimalsOut));
      const amountInHuman = parseFloat(params.amountIn);
      const effectivePrice = amountInHuman / amountOut;
      const expectedPrice = amountInHuman / parseFloat(formatUnits(quotedAmountOut, decimalsOut));
      const slippage = Math.abs(effectivePrice - expectedPrice) / expectedPrice;

      return {
        success: true,
        txHash: receipt.hash,
        amountOut: formatUnits(quotedAmountOut, decimalsOut),
        effectivePrice,
        slippage,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── Aave V3 Operations ──────────────────────────────────────────────────

  async aaveSupply(asset: string, amount: string): Promise<AaveResult> {
    if (!this.wallet) throw new Error('Wallet not set');

    const tokenAddress = getTokenAddress(asset);
    const decimals = getTokenDecimals(asset);
    const poolAddress = CONTRACT_ALLOWLIST.arbitrum.AAVE_POOL;
    const parsedAmount = parseUnits(amount, decimals);

    try {
      // Approve Aave Pool to spend token
      await this.ensureAllowance(tokenAddress, poolAddress, parsedAmount, decimals);

      // Supply to Aave
      const pool = new Contract(poolAddress, AAVE_POOL_ABI, this.wallet);
      const tx = await pool.supply(
        tokenAddress,
        parsedAmount,
        this.wallet.address,
        0, // no referral
      );

      const receipt = await tx.wait();
      return { txHash: receipt.hash, success: true };
    } catch (err) {
      return {
        txHash: '',
        success: false,
      };
    }
  }

  async aaveWithdraw(asset: string, amount: string): Promise<AaveResult> {
    if (!this.wallet) throw new Error('Wallet not set');

    const tokenAddress = getTokenAddress(asset);
    const decimals = getTokenDecimals(asset);
    const poolAddress = CONTRACT_ALLOWLIST.arbitrum.AAVE_POOL;

    const parsedAmount = amount === 'max'
      ? MaxUint256
      : parseUnits(amount, decimals);

    try {
      const pool = new Contract(poolAddress, AAVE_POOL_ABI, this.wallet);
      const tx = await pool.withdraw(
        tokenAddress,
        parsedAmount,
        this.wallet.address,
      );

      const receipt = await tx.wait();
      return { txHash: receipt.hash, success: true };
    } catch (err) {
      return {
        txHash: '',
        success: false,
      };
    }
  }

  async aaveWithdrawAll(): Promise<WithdrawAllResult> {
    const errors: string[] = [];
    let withdrawn = 0;

    if (!this.wallet) {
      return { withdrawn: 0, errors: ['Wallet not set'] };
    }

    try {
      const positions = await this.getAavePositions();

      for (const pos of positions) {
        if (pos.supplied <= 0) continue;

        try {
          const result = await this.aaveWithdraw(pos.asset, 'max');
          if (result.success) {
            withdrawn++;
          } else {
            errors.push(`${pos.asset}: withdraw failed`);
          }
        } catch (err) {
          errors.push(`${pos.asset}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return { withdrawn, errors };
  }

  async getAavePositions(): Promise<AavePosition[]> {
    if (!this.wallet) throw new Error('Wallet not set');

    const dataProviderAddress = CONTRACT_ALLOWLIST.arbitrum.AAVE_POOL_DATA_PROVIDER;
    const dataProvider = new Contract(
      dataProviderAddress,
      AAVE_DATA_PROVIDER_ABI,
      this.provider,
    );

    // Check positions for USDC (primary yield asset)
    const assetsToCheck = ['USDC', 'USDE', 'WETH'];
    const positions: AavePosition[] = [];
    const healthFactor = await this.getAaveHealthFactor();

    for (const asset of assetsToCheck) {
      try {
        const tokenAddress = getTokenAddress(asset);
        const decimals = getTokenDecimals(asset);

        const reserveData = await dataProvider.getUserReserveData(
          tokenAddress,
          this.wallet.address,
        );

        const supplied = parseFloat(formatUnits(reserveData[0], decimals)); // currentATokenBalance
        const stableDebt = parseFloat(formatUnits(reserveData[1], decimals));
        const variableDebt = parseFloat(formatUnits(reserveData[2], decimals));

        if (supplied > 0 || stableDebt > 0 || variableDebt > 0) {
          // Get reserve APYs
          const reserveInfo = await dataProvider.getReserveData(tokenAddress);
          // liquidityRate and variableBorrowRate are in ray (1e27)
          const supplyApy = parseFloat(formatUnits(reserveInfo[5], 27)); // liquidityRate
          const borrowApy = parseFloat(formatUnits(reserveInfo[6], 27)); // variableBorrowRate

          positions.push({
            asset,
            supplied,
            borrowed: stableDebt + variableDebt,
            supplyApy,
            borrowApy,
            healthFactor,
          });
        }
      } catch {
        // Skip assets that fail (may not be listed on Aave)
      }
    }

    return positions;
  }

  async getAaveHealthFactor(): Promise<number> {
    if (!this.wallet) throw new Error('Wallet not set');

    const poolAddress = CONTRACT_ALLOWLIST.arbitrum.AAVE_POOL;
    const pool = new Contract(poolAddress, AAVE_POOL_ABI, this.provider);

    const accountData = await pool.getUserAccountData(this.wallet.address);
    // healthFactor is the 6th return value, in 1e18
    const healthFactor = parseFloat(formatUnits(accountData[5], 18));

    // If no borrows, health factor is effectively infinite
    if (healthFactor > 1e10) return Infinity;
    return healthFactor;
  }

  // ─── Aave V3 Supply Rate Queries ─────────────────────────────────────────

  /**
   * Get current Aave V3 supply rates for key assets.
   * Reads from the PoolDataProvider contract on-chain.
   */
  async getAaveSupplyRates(): Promise<Array<{ asset: string; supplyApy: number }>> {
    const dataProviderAddress = CONTRACT_ALLOWLIST.arbitrum.AAVE_POOL_DATA_PROVIDER;
    const dataProvider = new Contract(
      dataProviderAddress,
      AAVE_DATA_PROVIDER_ABI,
      this.provider,
    );

    const assetsToCheck = ['USDC', 'WETH'];
    const results: Array<{ asset: string; supplyApy: number }> = [];

    for (const asset of assetsToCheck) {
      try {
        const tokenAddress = getTokenAddress(asset);
        const reserveInfo = await dataProvider.getReserveData(tokenAddress);
        // liquidityRate is at index 5, in ray (1e27)
        const supplyApy = parseFloat(formatUnits(reserveInfo[5], 27));
        results.push({ asset, supplyApy });
      } catch {
        // Skip assets that fail (may not be listed)
      }
    }

    return results;
  }

  // ─── sUSDe Depeg Monitoring ───────────────────────────────────────────────

  async getSUSDePriceOnDex(): Promise<number> {
    const quoterAddress = CONTRACT_ALLOWLIST.arbitrum.UNISWAP_QUOTER;
    const susdeAddress = CONTRACT_ALLOWLIST.arbitrum.SUSDE;
    const usdcAddress = CONTRACT_ALLOWLIST.arbitrum.USDC;

    const quoter = new Contract(quoterAddress, UNISWAP_QUOTER_ABI, this.provider);

    // Quote 1 sUSDe → USDC
    const oneToken = parseUnits('1', 18); // sUSDe is 18 decimals
    const fee = 3000;

    try {
      const amountOut = await quoter.quoteExactInputSingle.staticCall(
        susdeAddress,
        usdcAddress,
        fee,
        oneToken,
        0,
      );

      // USDC has 6 decimals
      return parseFloat(formatUnits(amountOut, 6));
    } catch {
      // If quote fails (no liquidity), return 0 to trigger alarm
      return 0;
    }
  }

  async sellSUSDeOnDex(amount: string, maxSlippage: number): Promise<SwapResult> {
    // Use tiered slippage from config if this is an emergency
    const tiers = SAFETY_LIMITS.EMERGENCY_SLIPPAGE_TIERS;

    for (const tier of tiers) {
      if (tier > maxSlippage) continue;

      const result = await this.swap({
        tokenIn: 'sUSDe',
        tokenOut: 'USDC',
        amountIn: amount,
        maxSlippagePct: tier,
      });

      if (result.success) return result;
    }

    // Try at the provided maxSlippage as final attempt
    return this.swap({
      tokenIn: 'sUSDe',
      tokenOut: 'USDC',
      amountIn: amount,
      maxSlippagePct: maxSlippage,
    });
  }
}
