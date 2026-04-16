import { Injectable, Logger } from '@nestjs/common';
import {
  ClobClient,
  Side,
  OrderType,
  AssetType,
  type OpenOrder,
  type OrderBookSummary,
  type TickSize,
} from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import type { ExecutionFill } from '@polymarket-ws/shared-types';
import {
  BuyParams,
  OrderExecutionResult,
  OrderExecutor,
  SellParams,
  WalletBalance,
} from './order-executor.interface';

export interface PolymarketExecutorConfig {
  privateKey: string;
  apiKey: string;
  secret: string;
  passphrase: string;
  maxOrderSizeUsd: number;
  /**
   * Max slippage as a fraction of reference price (0.03 = 3%). Sets the limit
   * price for FAK orders:
   *   Buy:  worst = min(ref * (1 + pct), maxValidPrice)
   *   Sell: worst = max(ref * (1 - pct), minValidPrice)
   */
  maxSlippagePct?: number;
  signatureType?: number;
  negRisk?: boolean;
  host?: string;
  chainId?: number;
}

/**
 * Live executor for the Polymarket CLOB.
 *
 * ## Strategy: FAK (Fill-and-Kill) with GTC fallback
 *
 * FAK orders execute immediately against available liquidity and cancel any
 * unfilled remainder — no polling or timeout needed. If the CLOB rejects the
 * order type (some markets), we fall back to GTC with polling.
 *
 * ## Slippage protection
 *
 * Limit price is set to the worst acceptable price given `maxSlippagePct`.
 * The CLOB will not fill beyond this price. The limit is clamped into the
 * valid tick range [tick, 1 - tick].
 *
 * ## Depth check
 *
 * Before placing we scan the book to estimate fillable depth within the
 * slippage range and log a warning if < 50% of requested size is available.
 * The order is still placed — FAK fills what it can.
 */
@Injectable()
export class PolymarketExecutor implements OrderExecutor {
  private readonly logger = new Logger(PolymarketExecutor.name);
  private readonly client: ClobClient;
  private readonly maxOrderSizeUsd: number;
  private readonly maxSlippagePct: number;
  private readonly negRisk: boolean;

  constructor(config: PolymarketExecutorConfig) {
    const host = config.host ?? 'https://clob.polymarket.com';
    const chainId = config.chainId ?? 137;
    const signer = new Wallet(config.privateKey);

    const signatureType = config.signatureType ?? 0;
    this.client = new ClobClient(
      host,
      chainId,
      signer,
      {
        key: config.apiKey,
        secret: config.secret,
        passphrase: config.passphrase,
      },
      signatureType,
    );
    this.maxOrderSizeUsd = config.maxOrderSizeUsd;
    this.maxSlippagePct = config.maxSlippagePct ?? 0.03;
    this.negRisk = config.negRisk ?? false;

    this.logger.log(
      `Initialized for ${host} (chain ${chainId}), max order $${this.maxOrderSizeUsd}, maxSlippage ${(this.maxSlippagePct * 100).toFixed(1)}%, negRisk=${this.negRisk}, sigType=${signatureType}`,
    );
  }

  async placeBuy(params: BuyParams): Promise<OrderExecutionResult> {
    const slippage = params.maxSlippagePct ?? this.maxSlippagePct;
    this.logger.log(
      `Placing BUY: ${params.size} tokens (ref $${params.price.toFixed(4)}, tokenId: ${params.tokenId.slice(0, 12)}...)`,
    );

    try {
      const tickSize = await this.client.getTickSize(params.tokenId);
      const book = await this.client.getOrderBook(params.tokenId);
      const sortedAsks = [...book.asks].sort(
        (a, b) => Number(a.price) - Number(b.price),
      );
      const bestAsk = sortedAsks.length > 0 ? Number(sortedAsks[0].price) : null;

      const maxValidPrice = this.roundToTick(1 - Number(tickSize), tickSize);
      const worstPrice = Math.min(
        this.roundToTick(params.price * (1 + slippage), tickSize),
        maxValidPrice,
      );

      this.logger.log(
        `Book best ask $${bestAsk ?? 'N/A'}, worst $${worstPrice.toFixed(4)} (slip ${(slippage * 100).toFixed(1)}%)`,
      );

      const depth = this.checkOrderbookDepth(
        { ...book, asks: sortedAsks },
        'buy',
        worstPrice,
        params.size,
      );
      if (depth.availableSize < params.size * 0.5) {
        this.logger.warn(
          `Low liquidity: ${depth.availableSize} of ${params.size} available (est VWAP $${depth.estimatedVwap.toFixed(4)})`,
        );
      }

      const orderValue = params.size * worstPrice;
      if (orderValue > this.maxOrderSizeUsd) {
        this.logger.error(
          `Buy rejected: $${orderValue.toFixed(2)} > cap $${this.maxOrderSizeUsd}`,
        );
        return {
          filled: false,
          avgPrice: 0,
          filledContracts: 0,
          fills: [],
          errorMessage: `order value $${orderValue.toFixed(2)} exceeds cap $${this.maxOrderSizeUsd}`,
        };
      }

      const resp = await this.client.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price: worstPrice,
          size: params.size,
          side: Side.BUY,
        },
        { tickSize, negRisk: this.negRisk },
        // FAK runtime-supported; not in the TS signature.
        OrderType.FAK as unknown as OrderType.GTC,
      );

      this.logger.log(`CLOB resp: ${JSON.stringify(resp)}`);

      if (!resp.success) {
        if (
          resp.errorMsg?.includes('order type') ||
          resp.error?.includes('order type')
        ) {
          this.logger.warn('FAK not supported, falling back to GTC for buy');
          return this.placeBuyGtcFallback(params, tickSize, bestAsk);
        }
        return {
          filled: false,
          avgPrice: 0,
          filledContracts: 0,
          fills: [],
          errorMessage: resp.errorMsg ?? resp.error ?? 'clob_rejected',
        };
      }

      return this.readOrderResult(resp.orderID);
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      this.logger.error(`Buy execution error: ${msg}`);
      return {
        filled: false,
        avgPrice: 0,
        filledContracts: 0,
        fills: [],
        errorMessage: msg,
      };
    }
  }

  async placeSell(params: SellParams): Promise<OrderExecutionResult> {
    const slippage = params.maxSlippagePct ?? this.maxSlippagePct;
    this.logger.log(
      `Placing SELL: ${params.size} tokens (ref $${params.price.toFixed(4)}, tokenId: ${params.tokenId.slice(0, 12)}...)`,
    );

    try {
      // Never sell more than we own.
      const tokenBalance = await this.getTokenBalance(params.tokenId);
      const size = Math.min(params.size, Math.floor(tokenBalance));
      if (size <= 0) {
        return {
          filled: false,
          avgPrice: 0,
          filledContracts: 0,
          fills: [],
          errorMessage: `no_tokens (balance ${tokenBalance})`,
        };
      }
      if (size < params.size) {
        this.logger.warn(
          `Adjusted sell size ${params.size} → ${size} (token balance ${tokenBalance})`,
        );
      }

      const tickSize = await this.client.getTickSize(params.tokenId);
      const book = await this.client.getOrderBook(params.tokenId);
      const sortedBids = [...book.bids].sort(
        (a, b) => Number(b.price) - Number(a.price),
      );
      const bestBid = sortedBids.length > 0 ? Number(sortedBids[0].price) : null;

      const minValidPrice = this.roundToTick(Number(tickSize), tickSize);
      const worstPrice = Math.max(
        this.roundToTick(params.price * (1 - slippage), tickSize),
        minValidPrice,
      );

      this.logger.log(
        `Book best bid $${bestBid ?? 'N/A'}, worst $${worstPrice.toFixed(4)} (size ${size}, slip ${(slippage * 100).toFixed(1)}%)`,
      );

      const depth = this.checkOrderbookDepth(
        { ...book, bids: sortedBids },
        'sell',
        worstPrice,
        size,
      );
      if (depth.availableSize < size * 0.5) {
        this.logger.warn(
          `Low bid-side liquidity: ${depth.availableSize} of ${size} (est VWAP $${depth.estimatedVwap.toFixed(4)})`,
        );
      }

      const resp = await this.client.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price: worstPrice,
          size,
          side: Side.SELL,
        },
        { tickSize, negRisk: this.negRisk },
        OrderType.FAK as unknown as OrderType.GTC,
      );

      this.logger.log(`CLOB resp: ${JSON.stringify(resp)}`);

      if (!resp.success) {
        if (
          resp.errorMsg?.includes('order type') ||
          resp.error?.includes('order type')
        ) {
          this.logger.warn('FAK not supported, falling back to GTC for sell');
          return this.placeSellGtcFallback(params, size, tickSize, bestBid);
        }
        return {
          filled: false,
          avgPrice: 0,
          filledContracts: 0,
          fills: [],
          errorMessage: resp.errorMsg ?? resp.error ?? 'clob_rejected',
        };
      }

      return this.readOrderResult(resp.orderID);
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      this.logger.error(`Sell execution error: ${msg}`);
      return {
        filled: false,
        avgPrice: 0,
        filledContracts: 0,
        fills: [],
        errorMessage: msg,
      };
    }
  }

  async getBalance(): Promise<WalletBalance> {
    try {
      const resp = await this.client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      return { balance: Number(resp.balance) / 1e6 };
    } catch (err) {
      this.logger.error(
        `Failed to fetch balance: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { balance: 0 };
    }
  }

  async getTokenBalance(tokenId: string): Promise<number> {
    const resp = await this.client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    return Number(resp.balance) / 1e6;
  }

  // ── FAK result reading ──────────────────────────────────────────────────

  /**
   * FAK orders execute instantly — we only need one read after a short delay
   * for propagation, with a couple of retries against transient errors.
   */
  private async readOrderResult(orderId: string): Promise<OrderExecutionResult> {
    await this.sleep(1_000);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const order = await this.client.getOrder(orderId);
        const matched = Number(order.size_matched);
        const total = Number(order.original_size);

        if (matched > 0) {
          const fills = await this.fetchFillsForOrder(order);
          const avgPrice = this.computeVwap(fills, Number(order.price));
          const filled = matched >= total;
          this.logger.log(
            `Order ${orderId} ${filled ? 'fully' : 'partially'} filled: ${matched}/${total} @ VWAP $${avgPrice.toFixed(4)}`,
          );
          return {
            filled,
            avgPrice,
            filledContracts: matched,
            externalOrderId: orderId,
            fills,
          };
        }

        if (
          order.status === 'CANCELED' ||
          order.status === 'EXPIRED' ||
          order.status === 'MATCHED'
        ) {
          this.logger.warn(`Order ${orderId} ${order.status} with 0 fills`);
          return {
            filled: false,
            avgPrice: 0,
            filledContracts: 0,
            fills: [],
            externalOrderId: orderId,
          };
        }
      } catch {
        // transient, retry
      }
      await this.sleep(1_000);
    }

    this.logger.warn(`Could not read FAK order ${orderId} after 3 attempts`);
    return {
      filled: false,
      avgPrice: 0,
      filledContracts: 0,
      fills: [],
      externalOrderId: orderId,
      errorMessage: 'fak_read_timeout',
    };
  }

  // ── GTC fallback ─────────────────────────────────────────────────────────

  private async placeBuyGtcFallback(
    params: BuyParams,
    tickSize: TickSize,
    bestAsk: number | null,
  ): Promise<OrderExecutionResult> {
    const price =
      bestAsk != null
        ? this.roundToTick(Math.min(bestAsk, params.price * 1.02), tickSize)
        : this.roundToTick(params.price, tickSize);

    const resp = await this.client.createAndPostOrder(
      {
        tokenID: params.tokenId,
        price,
        size: params.size,
        side: Side.BUY,
      },
      { tickSize, negRisk: this.negRisk },
      OrderType.GTC,
    );
    if (!resp.success) {
      return {
        filled: false,
        avgPrice: 0,
        filledContracts: 0,
        fills: [],
        errorMessage: resp.errorMsg ?? resp.error ?? 'gtc_buy_rejected',
      };
    }
    return this.pollOrderUntilFilled(resp.orderID, 60_000);
  }

  private async placeSellGtcFallback(
    params: SellParams,
    size: number,
    tickSize: TickSize,
    bestBid: number | null,
  ): Promise<OrderExecutionResult> {
    const price =
      bestBid != null
        ? this.roundToTick(Math.max(bestBid, params.price * 0.98), tickSize)
        : this.roundToTick(params.price, tickSize);

    const resp = await this.client.createAndPostOrder(
      {
        tokenID: params.tokenId,
        price,
        size,
        side: Side.SELL,
      },
      { tickSize, negRisk: this.negRisk },
      OrderType.GTC,
    );
    if (!resp.success) {
      return {
        filled: false,
        avgPrice: 0,
        filledContracts: 0,
        fills: [],
        errorMessage: resp.errorMsg ?? resp.error ?? 'gtc_sell_rejected',
      };
    }
    return this.pollOrderUntilFilled(resp.orderID, 30_000);
  }

  private async pollOrderUntilFilled(
    orderId: string,
    timeoutMs: number,
  ): Promise<OrderExecutionResult> {
    const start = Date.now();
    const interval = 2_000;

    while (Date.now() - start < timeoutMs) {
      try {
        const order = await this.client.getOrder(orderId);
        if (Number(order.size_matched) >= Number(order.original_size)) {
          const fills = await this.fetchFillsForOrder(order);
          const avgPrice = this.computeVwap(fills, Number(order.price));
          return {
            filled: true,
            avgPrice,
            filledContracts: Number(order.size_matched),
            externalOrderId: orderId,
            fills,
          };
        }
        if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
          const matched = Number(order.size_matched);
          if (matched > 0) {
            const fills = await this.fetchFillsForOrder(order);
            const avgPrice = this.computeVwap(fills, Number(order.price));
            return {
              filled: false,
              avgPrice,
              filledContracts: matched,
              externalOrderId: orderId,
              fills,
            };
          }
          return {
            filled: false,
            avgPrice: 0,
            filledContracts: 0,
            fills: [],
            externalOrderId: orderId,
            errorMessage: order.status.toLowerCase(),
          };
        }
      } catch {
        // transient, continue
      }
      await this.sleep(interval);
    }

    // Timeout — cancel and grab partial if any.
    try {
      await this.client.cancelOrder({ orderID: orderId });
    } catch {
      // best-effort
    }
    try {
      const finalOrder = await this.client.getOrder(orderId);
      const matched = Number(finalOrder.size_matched);
      if (matched > 0) {
        const fills = await this.fetchFillsForOrder(finalOrder);
        const avgPrice = this.computeVwap(fills, Number(finalOrder.price));
        return {
          filled: false,
          avgPrice,
          filledContracts: matched,
          externalOrderId: orderId,
          fills,
          errorMessage: 'gtc_timeout_partial',
        };
      }
    } catch {
      // ignore
    }
    return {
      filled: false,
      avgPrice: 0,
      filledContracts: 0,
      fills: [],
      externalOrderId: orderId,
      errorMessage: 'gtc_timeout',
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private checkOrderbookDepth(
    book: OrderBookSummary,
    side: 'buy' | 'sell',
    worstPrice: number,
    requestedSize: number,
  ): { availableSize: number; estimatedVwap: number } {
    const levels = side === 'buy' ? book.asks : book.bids;
    let totalSize = 0;
    let totalValue = 0;
    for (const level of levels) {
      const price = Number(level.price);
      const size = Number(level.size);
      if (side === 'buy' && price > worstPrice) break;
      if (side === 'sell' && price < worstPrice) break;
      const fillSize = Math.min(size, requestedSize - totalSize);
      totalSize += fillSize;
      totalValue += fillSize * price;
      if (totalSize >= requestedSize) break;
    }
    return {
      availableSize: totalSize,
      estimatedVwap: totalSize > 0 ? totalValue / totalSize : 0,
    };
  }

  private async fetchFillsForOrder(order: OpenOrder): Promise<ExecutionFill[]> {
    const tradeIds = order.associate_trades ?? [];
    if (tradeIds.length === 0) {
      this.logger.warn(`No associate_trades for order ${order.id}, fallback`);
      return [
        {
          tradeId: `fallback-${order.id}`,
          price: Number(order.price),
          size: Number(order.size_matched),
          priceSource: 'fallback',
        },
      ];
    }

    const fills: ExecutionFill[] = [];
    for (const tradeId of tradeIds) {
      try {
        const trades = await this.client.getTrades({ id: tradeId });
        if (trades.length > 0) {
          const t = trades[0];
          fills.push({
            tradeId: t.id,
            price: Number(t.price),
            size: Number(t.size),
            feeBps: Number(t.fee_rate_bps),
            txHash: t.transaction_hash,
            matchedAt: t.match_time,
            priceSource: 'trade',
          });
        }
      } catch (err) {
        this.logger.warn(
          `Failed to fetch trade ${tradeId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (fills.length === 0) {
      return [
        {
          tradeId: `fallback-${order.id}`,
          price: Number(order.price),
          size: Number(order.size_matched),
          priceSource: 'fallback',
        },
      ];
    }

    return fills;
  }

  private computeVwap(fills: ExecutionFill[], limitPrice: number): number {
    if (fills.length === 0) return limitPrice;
    let totalValue = 0;
    let totalVolume = 0;
    for (const f of fills) {
      totalValue += f.price * f.size;
      totalVolume += f.size;
    }
    if (totalVolume === 0) return limitPrice;
    return totalValue / totalVolume;
  }

  private roundToTick(price: number, tickSize: string): number {
    const tick = Number(tickSize);
    return Math.round(price / tick) * tick;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
