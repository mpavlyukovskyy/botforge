/**
 * Argus Trading System — Hyperliquid Exchange Adapter
 *
 * Real implementation using @nktkas/hyperliquid SDK.
 * Handles order management, position queries, funding rates,
 * and WebSocket subscriptions for real-time data.
 */

import {
  HttpTransport,
  WebSocketTransport,
  InfoClient,
  ExchangeClient,
  SubscriptionClient,
} from '@nktkas/hyperliquid';
import WebSocket from 'ws';
import type { PrivateKeyAccount } from 'viem';
import type {
  OrderParams,
  OrderResult,
  HyperliquidPosition,
  HyperliquidFundingPayment,
  FundingRate,
} from '../lib/types.js';
import { IS_TESTNET } from '../lib/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HyperliquidAdapterOptions {
  testnet?: boolean;
  wallet?: PrivateKeyAccount;
}

interface OpenOrder {
  oid: number;
  asset: string;
  side: string;
  size: number;
  price: number;
}

interface Balances {
  free: number;
  total: number;
  margin: number;
}

interface FundingRateInfo {
  rate: number;
  annualized: number;
  nextFunding: string;
}

interface CancelAllResult {
  cancelled: number;
  errors: string[];
}

interface CloseAllResult {
  closed: number;
  errors: string[];
}

// ─── Asset Index Map ──────────────────────────────────────────────────────────

// Built from meta() call on first use — maps symbol to asset index
let assetIndexMap: Map<string, number> | null = null;

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class HyperliquidAdapter {
  private readonly testnet: boolean;
  private readonly wallet: PrivateKeyAccount | null;

  private httpTransport!: HttpTransport;
  private wsTransport!: WebSocketTransport;
  private info!: InfoClient;
  private exchange: ExchangeClient | null = null;
  private subscriptions!: SubscriptionClient;

  private connected = false;
  private activeSubscriptions: Array<{ unsubscribe: () => Promise<void> }> = [];

  constructor(options?: HyperliquidAdapterOptions) {
    this.testnet = options?.testnet ?? IS_TESTNET;
    this.wallet = options?.wallet ?? null;
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return;

    this.httpTransport = new HttpTransport({
      isTestnet: this.testnet,
      timeout: 15_000,
    });

    this.wsTransport = new WebSocketTransport({
      isTestnet: this.testnet,
      timeout: 15_000,
      reconnect: {
        WebSocket: WebSocket as any,
      },
    });

    this.info = new InfoClient({ transport: this.httpTransport });
    this.subscriptions = new SubscriptionClient({ transport: this.wsTransport });

    if (this.wallet) {
      this.exchange = new ExchangeClient({
        transport: this.httpTransport,
        wallet: this.wallet,
      });
    }

    // Build asset index map
    await this.buildAssetIndexMap();

    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    // Unsubscribe all active WS subscriptions
    for (const sub of this.activeSubscriptions) {
      try {
        await sub.unsubscribe();
      } catch { /* ignore cleanup errors */ }
    }
    this.activeSubscriptions = [];
    this.connected = false;
  }

  // ─── Asset Index Resolution ─────────────────────────────────────────────

  private async buildAssetIndexMap(): Promise<void> {
    if (assetIndexMap) return;

    const meta = await this.info.meta();
    assetIndexMap = new Map<string, number>();
    for (let i = 0; i < meta.universe.length; i++) {
      assetIndexMap.set(meta.universe[i].name, i);
    }
  }

  private getAssetIndex(asset: string): number {
    if (!assetIndexMap) {
      throw new Error('Asset index map not built — call connect() first');
    }
    const index = assetIndexMap.get(asset);
    if (index === undefined) {
      throw new Error(`Unknown asset: ${asset}. Available: ${[...assetIndexMap.keys()].join(', ')}`);
    }
    return index;
  }

  // ─── Order Management ─────────────────────────────────────────────────────

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    if (!this.exchange) {
      throw new Error('Exchange client not initialized — provide wallet in constructor');
    }

    const assetIndex = this.getAssetIndex(params.asset);
    const isBuy = params.side === 'buy';

    // Build order: market if no price, limit otherwise
    const tif = params.price
      ? { limit: { tif: 'Gtc' as const } }
      : { limit: { tif: 'FrontendMarket' as const } };

    const price = params.price
      ? String(params.price)
      : isBuy ? '999999' : '0.01'; // Placeholder for market orders

    try {
      const response = await this.exchange.order({
        orders: [{
          a: assetIndex,
          b: isBuy,
          p: price,
          s: String(params.size),
          r: params.reduceOnly ?? false,
          t: tif,
        }],
        grouping: 'na',
      });

      const status = (response as any).response?.data?.statuses?.[0];
      if (!status) {
        return { success: false, error: 'No status in response' };
      }

      if (status.error) {
        return { success: false, error: status.error };
      }

      if (status.filled) {
        return {
          success: true,
          orderId: String(status.filled.oid),
          fillPrice: parseFloat(status.filled.avgPx),
          fillSize: parseFloat(status.filled.totalSz),
        };
      }

      if (status.resting) {
        return {
          success: true,
          orderId: String(status.resting.oid),
        };
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async cancelOrder(orderId: string, asset: string): Promise<boolean> {
    if (!this.exchange) {
      throw new Error('Exchange client not initialized');
    }

    const assetIndex = this.getAssetIndex(asset);

    try {
      const response = await this.exchange.cancel({
        cancels: [{ a: assetIndex, o: parseInt(orderId, 10) }],
      });

      const status = (response as any).response?.data?.statuses?.[0];
      return status === 'success';
    } catch {
      return false;
    }
  }

  async cancelAllOrders(): Promise<CancelAllResult> {
    const errors: string[] = [];
    let cancelled = 0;

    if (!this.exchange || !this.wallet) {
      return { cancelled: 0, errors: ['Exchange client not initialized'] };
    }

    try {
      const orders = await this.info.openOrders({ user: this.wallet.address });

      if (orders.length === 0) {
        return { cancelled: 0, errors: [] };
      }

      // Cancel in batches
      const cancels = orders.map((o: any) => ({
        a: this.getAssetIndex(o.coin),
        o: o.oid,
      }));

      const response = await this.exchange.cancel({ cancels });
      const statuses = (response as any).response?.data?.statuses ?? [];

      for (const s of statuses) {
        if (s === 'success') {
          cancelled++;
        } else if (s?.error) {
          errors.push(s.error);
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return { cancelled, errors };
  }

  async closeAllPositions(): Promise<CloseAllResult> {
    const errors: string[] = [];
    let closed = 0;

    if (!this.exchange || !this.wallet) {
      return { closed: 0, errors: ['Exchange client not initialized'] };
    }

    try {
      const positions = await this.getPositions();

      for (const pos of positions) {
        try {
          const result = await this.placeOrder({
            asset: pos.asset,
            side: pos.size > 0 ? 'sell' : 'buy',
            size: Math.abs(pos.size),
            reduceOnly: true,
          });

          if (result.success) {
            closed++;
          } else {
            errors.push(`${pos.asset}: ${result.error}`);
          }
        } catch (err) {
          errors.push(`${pos.asset}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return { closed, errors };
  }

  // ─── Position & Balance Queries ───────────────────────────────────────────

  async getPositions(): Promise<HyperliquidPosition[]> {
    if (!this.wallet) {
      throw new Error('Wallet not set — cannot query positions');
    }

    const state = await this.info.clearinghouseState({
      user: this.wallet.address,
    });

    return (state.assetPositions ?? [])
      .filter((ap: any) => parseFloat(ap.position.szi) !== 0)
      .map((ap: any) => {
        const pos = ap.position;
        return {
          asset: pos.coin,
          size: parseFloat(pos.szi),
          entryPrice: parseFloat(pos.entryPx ?? '0'),
          markPrice: parseFloat(pos.positionValue ?? '0') / Math.abs(parseFloat(pos.szi) || 1),
          unrealizedPnl: parseFloat(pos.unrealizedPnl ?? '0'),
          leverage: pos.leverage?.value ?? 1,
          marginUsed: parseFloat(pos.marginUsed ?? '0'),
          liquidationPrice: parseFloat(pos.liquidationPx ?? '0'),
        };
      });
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    if (!this.wallet) {
      throw new Error('Wallet not set');
    }

    const orders = await this.info.openOrders({ user: this.wallet.address });

    return orders.map((o: any) => ({
      oid: o.oid,
      asset: o.coin,
      side: o.side,
      size: parseFloat(o.sz),
      price: parseFloat(o.limitPx),
    }));
  }

  async getBalances(): Promise<Balances> {
    if (!this.wallet) {
      throw new Error('Wallet not set');
    }

    const state = await this.info.clearinghouseState({
      user: this.wallet.address,
    });

    const margin = state.marginSummary;
    return {
      free: parseFloat(margin.accountValue) - parseFloat(margin.totalMarginUsed),
      total: parseFloat(margin.accountValue),
      margin: parseFloat(margin.totalMarginUsed),
    };
  }

  // ─── Funding Rate Data ────────────────────────────────────────────────────

  async getFundingRate(asset: string): Promise<FundingRateInfo> {
    // Primary: use metaAndAssetCtxs which returns funding in asset contexts
    try {
      const ctxs = await this.info.metaAndAssetCtxs();
      const meta = (ctxs as any)[0];
      const assetCtxs = (ctxs as any)[1];

      const assetIndex = meta.universe.findIndex((u: any) => u.name === asset);
      if (assetIndex !== -1) {
        const ctx = assetCtxs[assetIndex];
        const rate = parseFloat(ctx?.funding ?? '0');
        return {
          rate,
          annualized: rate * 3 * 365, // 8h rate * 3 * 365
          nextFunding: '',
        };
      }
    } catch { /* fall through to predictedFundings */ }

    // Fallback: predictedFundings API
    const predictions = await this.info.predictedFundings();

    for (const entry of predictions as any[]) {
      // Handle both array-of-tuples and array-of-objects formats
      const coin = Array.isArray(entry) ? entry[0] : entry?.coin;
      const exchanges = Array.isArray(entry) ? entry[1] : entry?.exchanges;

      if (coin !== asset) continue;

      if (Array.isArray(exchanges)) {
        for (const exEntry of exchanges) {
          const exchange = Array.isArray(exEntry) ? exEntry[0] : exEntry?.exchange;
          const data = Array.isArray(exEntry) ? exEntry[1] : exEntry;

          if (exchange === 'Hyperliquid' || exchange === 'HyperliquidPerp') {
            const rate = parseFloat(data?.fundingRate ?? '0');
            return {
              rate,
              annualized: rate * 3 * 365,
              nextFunding: String(data?.nextFundingTime ?? ''),
            };
          }
        }
      }
    }

    throw new Error(`Funding rate not found for ${asset}`);
  }

  async getFundingHistory(
    asset: string,
    limit: number = 50,
  ): Promise<HyperliquidFundingPayment[]> {
    if (!this.wallet) {
      throw new Error('Wallet not set');
    }

    const history = await this.info.userFunding({
      user: this.wallet.address,
      startTime: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days
      endTime: Date.now(),
    });

    return (history as any[])
      .filter((h: any) => h.delta?.coin === asset)
      .slice(0, limit)
      .map((h: any) => ({
        timestamp: new Date(h.time).toISOString(),
        asset: h.delta.coin,
        amount: parseFloat(h.delta.usdc),
        rate: parseFloat(h.delta.fundingRate),
      }));
  }

  async getOpenInterest(asset: string): Promise<number> {
    const ctxs = await this.info.metaAndAssetCtxs();
    const meta = (ctxs as any)[0];
    const assetCtxs = (ctxs as any)[1];

    const assetIndex = meta.universe.findIndex((u: any) => u.name === asset);
    if (assetIndex === -1) {
      throw new Error(`Asset ${asset} not found`);
    }

    const ctx = assetCtxs[assetIndex];
    return parseFloat(ctx?.openInterest ?? '0');
  }

  // ─── Mid Prices ──────────────────────────────────────────────────────────

  async getAllMidPrices(): Promise<Record<string, number>> {
    const mids = await this.info.allMids();
    const result: Record<string, number> = {};
    for (const [asset, price] of Object.entries(mids)) {
      result[asset] = parseFloat(price as string);
    }
    return result;
  }

  // ─── WebSocket Subscriptions ──────────────────────────────────────────────

  async subscribeToPrices(
    callback: (asset: string, price: number) => void,
  ): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected — call connect() first');
    }

    const sub = await this.subscriptions.allMids((data: any) => {
      for (const [asset, price] of Object.entries(data.mids)) {
        callback(asset, parseFloat(price as string));
      }
    });

    this.activeSubscriptions.push(sub);
  }

  async subscribeToFunding(
    callback: (data: FundingRate) => void,
  ): Promise<void> {
    if (!this.connected || !this.wallet) {
      throw new Error('Not connected or no wallet set');
    }

    const sub = await this.subscriptions.userFundings(
      { user: this.wallet.address },
      (data: any) => {
        const delta = data.delta;
        callback({
          id: 0,
          timestamp: new Date(data.time).toISOString(),
          asset: delta.coin,
          exchange: 'hyperliquid',
          rate: parseFloat(delta.fundingRate),
          annualized: parseFloat(delta.fundingRate) * 3 * 365,
        });
      },
    );

    this.activeSubscriptions.push(sub);
  }

  async subscribeToOrderUpdates(
    callback: (data: any) => void,
  ): Promise<void> {
    if (!this.connected || !this.wallet) {
      throw new Error('Not connected or no wallet set');
    }

    const sub = await this.subscriptions.orderUpdates(
      { user: this.wallet.address },
      callback,
    );

    this.activeSubscriptions.push(sub);
  }
}
