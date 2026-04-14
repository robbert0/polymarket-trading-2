import { Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { firstValueFrom } from 'rxjs';
import {
  ARBITRAGE_EDGE_THRESHOLD,
  EVENTS,
} from '@polymarket-ws/shared-types';
import type {
  EdgeComparison,
  OrderbookDepth,
  DeribitTicker,
  DeribitOption,
  BookMessage,
} from '@polymarket-ws/shared-types';
import { DeribitWsService } from '../deribit/deribit-ws.service';
import { ClobWsService } from '../polymarket/clob-ws/clob-ws.service';
import { ClobRestService } from '../polymarket/clob-rest/clob-rest.service';
import { parseBet } from './parse-bet';

interface CachedMarket {
  marketId: string;
  label: string;
  strike: number;
  expiry: string;
  instrumentName: string;
  yesPrice: number;
  yesTokenId: string;
  iv: number;
  spotPrice: number;
  slug?: string;
  volume?: number;
  liquidity?: number;
  bids: [number, number][];
  asks: [number, number][];
  bookTimestamp: number;
}

interface PolymarketApiMarket {
  id: string;
  question: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  liquidity: string;
  volume: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  clobTokenIds: string;
}

interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  markets: PolymarketApiMarket[];
}

@Injectable()
export class EdgeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EdgeService.name);
  private readonly GAMMA_API = 'https://gamma-api.polymarket.com';
  private readonly BOOK_THROTTLE_MS = 500;
  private readonly BOOK_REFRESH_MS = 10_000;

  /** marketId → cached market data */
  private marketCache = new Map<string, CachedMarket>();
  /** Deribit instrument name → marketId (for fast lookup on option ticker) */
  private instrumentToMarket = new Map<string, string>();
  /** Polymarket YES token ID → marketId (for fast lookup on price_change) */
  private tokenToMarket = new Map<string, string>();
  /** Trailing-edge throttle timers for book updates */
  private bookRecalcTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private bookRefreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly eventEmitter: EventEmitter2,
    private readonly deribitWsService: DeribitWsService,
    private readonly clobWsService: ClobWsService,
    private readonly clobRestService: ClobRestService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshMarkets();
    this.bookRefreshInterval = setInterval(
      () => this.fetchOrderbooks(),
      this.BOOK_REFRESH_MS,
    );
  }

  onApplicationShutdown(): void {
    if (this.bookRefreshInterval) {
      clearInterval(this.bookRefreshInterval);
      this.bookRefreshInterval = null;
    }
    for (const timer of this.bookRecalcTimers.values()) {
      clearTimeout(timer);
    }
    this.bookRecalcTimers.clear();
  }

  /**
   * Called by BullMQ repeatable job every 60s.
   * Discovers BTC markets, subscribes to Deribit WS + Polymarket CLOB WS.
   */
  async refreshMarkets(): Promise<void> {
    const markets = await this.fetchBitcoinMarkets();
    const deribitInstruments: string[] = [];
    const clobTokenIds: string[] = [];

    for (const market of markets) {
      const parsed = parseBet(market.question, market.endDate);
      if (!parsed) continue;

      let prices: number[];
      let tokenIds: string[];
      let outcomes: string[];
      try {
        prices = JSON.parse(market.outcomePrices);
        tokenIds = JSON.parse(market.clobTokenIds);
        outcomes = JSON.parse(market.outcomes);
      } catch {
        continue;
      }

      // Find the YES index — outcomes can be ["Yes","No"] or ["No","Yes"]
      const yesIndex = outcomes.findIndex(
        (o) => o.toLowerCase() === 'yes',
      );
      if (yesIndex === -1) continue;

      const yesPrice = prices[yesIndex];
      const yesTokenId = tokenIds[yesIndex];
      if (!yesPrice || yesPrice <= 0 || yesPrice >= 1) continue;
      if (!yesTokenId) continue;

      const instrumentName = `BTC-${parsed.expiry}-${parsed.strike}-C`;
      const expiryDate = this.parseExpiryToISO(parsed.expiry);
      const label = `BTC > $${(parsed.strike / 1000).toFixed(0)}k on ${expiryDate}`;

      this.logger.debug(
        `Matched: "${market.question}" → ${instrumentName} yesIdx=${yesIndex} yesPrice=${yesPrice}`,
      );

      const existing = this.marketCache.get(market.id);

      this.marketCache.set(market.id, {
        marketId: market.id,
        label,
        strike: parsed.strike,
        expiry: parsed.expiry,
        instrumentName,
        yesPrice,
        yesTokenId,
        iv: existing?.iv ?? 0,
        spotPrice: existing?.spotPrice ?? 0,
        slug: market.slug,
        volume: parseFloat(market.volume) || 0,
        liquidity: parseFloat(market.liquidity) || 0,
        bids: existing?.bids ?? [],
        asks: existing?.asks ?? [],
        bookTimestamp: existing?.bookTimestamp ?? 0,
      });

      this.instrumentToMarket.set(instrumentName, market.id);
      this.tokenToMarket.set(yesTokenId, market.id);

      deribitInstruments.push(instrumentName);
      clobTokenIds.push(yesTokenId);
    }

    // Subscribe to Deribit option instruments
    if (deribitInstruments.length > 0) {
      this.deribitWsService.subscribeInstruments(deribitInstruments);
      this.logger.log(
        `Subscribed to ${deribitInstruments.length} Deribit option instruments`,
      );
    }

    // Subscribe to Polymarket CLOB for YES token prices
    if (clobTokenIds.length > 0) {
      this.clobWsService.subscribe(clobTokenIds);
      this.logger.log(
        `Subscribed to ${clobTokenIds.length} Polymarket CLOB tokens`,
      );
    }

    this.logger.log(
      `Edge market cache refreshed: ${this.marketCache.size} markets`,
    );

    // Fetch orderbooks via REST to seed the cache
    await this.fetchOrderbooks();
  }

  private async fetchOrderbooks(): Promise<void> {
    const entries = [...this.marketCache.values()];
    const results = await Promise.allSettled(
      entries.map(async (market) => {
        const book = (await this.clobRestService.getOrderBook(
          market.yesTokenId,
        )) as {
          bids?: { price: string; size: string }[];
          asks?: { price: string; size: string }[];
        };

        if (book.bids) {
          market.bids = book.bids
            .map(
              (b) =>
                [parseFloat(b.price), parseFloat(b.size)] as [number, number],
            )
            .filter(([p, s]) => p > 0 && s > 0)
            .sort((a, b) => b[0] - a[0]);
        }
        if (book.asks) {
          market.asks = book.asks
            .map(
              (a) =>
                [parseFloat(a.price), parseFloat(a.size)] as [number, number],
            )
            .filter(([p, s]) => p > 0 && s > 0)
            .sort((a, b) => a[0] - b[0]);
        }
        market.bookTimestamp = Date.now();
        this.updateYesPriceFromBook(market);
      }),
    );

    const fetched = results.filter((r) => r.status === 'fulfilled').length;
    if (fetched > 0) {
      this.recalculateAllAndEmit();
    }
    this.logger.debug(
      `Orderbook refresh: ${fetched}/${entries.length} successful`,
    );
  }

  /**
   * Deribit option ticker — update IV + spot price for the matching market.
   */
  @OnEvent(EVENTS.DERIBIT.OPTIONS)
  onDeribitOption(payload: DeribitOption): void {
    const marketId = this.instrumentToMarket.get(payload.instrument_name);
    if (!marketId) return;

    const market = this.marketCache.get(marketId);
    if (!market) return;

    market.iv = payload.mark_iv / 100;
    market.spotPrice = payload.underlying_price;

    this.recalculateAndEmit(market);
  }

  /**
   * Deribit perpetual ticker — update spot price for ALL markets.
   * index_price from BTC-PERPETUAL is the BTC spot price.
   */
  @OnEvent(EVENTS.DERIBIT.TICKER)
  onDeribitTicker(payload: DeribitTicker): void {
    if (!payload.instrument_name.includes('BTC')) return;
    if (!payload.index_price || payload.index_price <= 0) return;

    const newSpot = payload.index_price;
    let anyChange = false;

    for (const market of this.marketCache.values()) {
      if (Math.abs(newSpot - market.spotPrice) >= 1) {
        market.spotPrice = newSpot;
        anyChange = true;
      }
    }

    if (anyChange) {
      this.recalculateAllAndEmit();
    }
  }

  /**
   * Polymarket CLOB book update — update orderbook for the matching market.
   */
  @OnEvent(EVENTS.POLYMARKET.BOOK_UPDATE)
  onBookUpdate(payload: BookMessage): void {
    const marketId = this.tokenToMarket.get(payload.asset_id);
    if (!marketId) {
      this.logger.debug(
        `Book update for untracked asset ${payload.asset_id?.substring(0, 12)}... (${payload.bids?.length ?? 0} bids, ${payload.asks?.length ?? 0} asks)`,
      );
      return;
    }
    this.logger.debug(`Book update for market ${marketId.substring(0, 12)}...`);

    const market = this.marketCache.get(marketId);
    if (!market) return;

    market.bids = (payload.bids ?? [])
      .map((b) => [parseFloat(b.price), parseFloat(b.size)] as [number, number])
      .filter(([p, s]) => p > 0 && s > 0)
      .sort((a, b) => b[0] - a[0]);

    market.asks = (payload.asks ?? [])
      .map((a) => [parseFloat(a.price), parseFloat(a.size)] as [number, number])
      .filter(([p, s]) => p > 0 && s > 0)
      .sort((a, b) => a[0] - b[0]);

    market.bookTimestamp = payload.timestamp;
    this.updateYesPriceFromBook(market);

    this.scheduleBookRecalc(marketId);
  }

  /**
   * Derive the canonical YES price from the current orderbook.
   * Uses mid of best bid/ask when both available, else the single side.
   * If the book is empty, leaves the existing yesPrice (e.g. outcomePrices bootstrap).
   */
  private updateYesPriceFromBook(market: CachedMarket): void {
    const bestBid = market.bids[0]?.[0];
    const bestAsk = market.asks[0]?.[0];
    if (bestBid !== undefined && bestAsk !== undefined) {
      market.yesPrice = (bestBid + bestAsk) / 2;
    } else if (bestAsk !== undefined) {
      market.yesPrice = bestAsk;
    } else if (bestBid !== undefined) {
      market.yesPrice = bestBid;
    }
  }

  private scheduleBookRecalc(marketId: string): void {
    if (this.bookRecalcTimers.has(marketId)) return;

    this.bookRecalcTimers.set(
      marketId,
      setTimeout(() => {
        this.bookRecalcTimers.delete(marketId);
        const market = this.marketCache.get(marketId);
        if (market) this.recalculateAndEmit(market);
      }, this.BOOK_THROTTLE_MS),
    );
  }

  private recalculateAllAndEmit(): void {
    for (const market of this.marketCache.values()) {
      this.recalculateAndEmit(market);
    }
  }

  private recalculateAndEmit(market: CachedMarket): void {
    if (market.iv <= 0 || market.spotPrice <= 0) return;

    const T = this.yearsToExpiry(market.expiry);
    if (T <= 0) return;

    const d2 = this.calcD2(market.spotPrice, market.strike, market.iv, T);
    const deribitProbability = this.normalCDF(d2);

    const diff = deribitProbability - market.yesPrice;
    const edge = Math.abs(diff);
    let advice: 'BUY_YES' | 'BUY_NO' | 'NO_TRADE' = 'NO_TRADE';

    if (diff > ARBITRAGE_EDGE_THRESHOLD) {
      advice = 'BUY_YES';
    } else if (diff < -ARBITRAGE_EDGE_THRESHOLD) {
      advice = 'BUY_NO';
    }

    if (edge > 0.5) {
      this.logger.warn(
        `Suspicious edge ${(edge * 100).toFixed(1)}% on ${market.label}: ` +
          `deribit=${(deribitProbability * 100).toFixed(1)}% poly=${(market.yesPrice * 100).toFixed(1)}% ` +
          `spot=${market.spotPrice} strike=${market.strike} iv=${(market.iv * 100).toFixed(1)}% T=${T.toFixed(4)}`,
      );
    }

    const orderbook = this.computeOrderbookDepth(
      market,
      deribitProbability,
      advice,
    );

    const comparison: EdgeComparison = {
      marketId: market.marketId,
      label: market.label,
      strike: market.strike,
      expiry: market.expiry,
      instrumentName: market.instrumentName,
      deribitProbability,
      polymarketProbability: market.yesPrice,
      difference: diff,
      underlyingPrice: market.spotPrice,
      impliedVolatility: market.iv * 100,
      advice,
      edge,
      slug: market.slug,
      volume: market.volume,
      liquidity: market.liquidity,
      timestamp: Date.now(),
      orderbook,
    };

    this.eventEmitter.emit(EVENTS.DERIVED.EDGE, comparison);
  }

  private computeOrderbookDepth(
    market: CachedMarket,
    deribitProbability: number,
    advice: 'BUY_YES' | 'BUY_NO' | 'NO_TRADE',
  ): OrderbookDepth | undefined {
    if (market.bids.length === 0 && market.asks.length === 0) return undefined;

    const bestBid = market.bids[0]?.[0];
    const bestBidSize = market.bids[0]?.[1];
    const bestAsk = market.asks[0]?.[0];
    const bestAskSize = market.asks[0]?.[1];
    const spread =
      bestAsk !== undefined && bestBid !== undefined
        ? bestAsk - bestBid
        : undefined;

    let executableEdge: number | undefined;
    let fillableAmount = 0;
    let weightedPriceSum = 0;
    let effectivePrice: number | undefined;

    if (advice === 'BUY_YES' && bestAsk !== undefined) {
      executableEdge = deribitProbability - bestAsk;
      for (const [price, size] of market.asks) {
        if (price >= deribitProbability) break;
        fillableAmount += size;
        weightedPriceSum += price * size;
      }
      if (fillableAmount > 0) {
        effectivePrice = weightedPriceSum / fillableAmount;
      }
    } else if (advice === 'BUY_NO' && bestBid !== undefined) {
      executableEdge = bestBid - deribitProbability;
      for (const [price, size] of market.bids) {
        if (price <= deribitProbability) break;
        fillableAmount += size;
        weightedPriceSum += price * size;
      }
      if (fillableAmount > 0) {
        effectivePrice = weightedPriceSum / fillableAmount;
      }
    }

    const fillScore = this.computeFillScore(
      spread,
      fillableAmount,
      bestAskSize,
      bestBidSize,
      advice,
    );

    return {
      bestAsk,
      bestAskSize,
      bestBid,
      bestBidSize,
      spread,
      fillableAmount: fillableAmount > 0 ? fillableAmount : undefined,
      effectivePrice,
      executableEdge,
      fillScore,
    };
  }

  private computeFillScore(
    spread: number | undefined,
    fillableAmount: number,
    bestAskSize: number | undefined,
    bestBidSize: number | undefined,
    advice: 'BUY_YES' | 'BUY_NO' | 'NO_TRADE',
  ): number {
    if (advice === 'NO_TRADE') return 0;
    if (fillableAmount <= 0) return 0;

    let score = 30; // liquidity exists

    // Depth (0-30 points, capped at $5000)
    score += Math.min(30, (fillableAmount / 5000) * 30);

    // Spread tightness (0-20 points)
    if (spread !== undefined && spread > 0) {
      score += Math.max(0, 1 - (spread - 0.01) / 0.09) * 20;
    }

    // Best level size (0-20 points, capped at $1000)
    const relevantBestSize =
      advice === 'BUY_YES' ? bestAskSize : bestBidSize;
    if (relevantBestSize) {
      score += Math.min(20, (relevantBestSize / 1000) * 20);
    }

    return Math.round(Math.min(100, score));
  }

  private async fetchBitcoinMarkets(): Promise<PolymarketApiMarket[]> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<PolymarketEvent[]>(`${this.GAMMA_API}/events`, {
          params: { tag_slug: 'crypto', active: true, closed: false, limit: 500 },
        }),
      );

      return data.flatMap((event) =>
        event.markets.filter(
          (m) =>
            m.active &&
            !m.closed &&
            m.question.toLowerCase().includes('bitcoin') &&
            m.question.toLowerCase().includes('above'),
        ),
      );
    } catch (err) {
      this.logger.error(`Failed to fetch Polymarket markets: ${err.message}`);
      return [];
    }
  }

  private calcD2(S: number, K: number, sigma: number, T: number): number {
    const sqrtT = Math.sqrt(T);
    return (Math.log(S / K) + -0.5 * sigma * sigma * T) / (sigma * sqrtT);
  }

  private normalCDF(x: number): number {
    if (x > 6) return 1;
    if (x < -6) return 0;

    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);
    const t = 1.0 / (1.0 + p * absX);
    const y =
      1.0 -
      ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
        t *
        Math.exp(-0.5 * absX * absX);

    return 0.5 * (1.0 + sign * y);
  }

  private parseExpiryToISO(expiry: string): string {
    const months: Record<string, string> = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
      JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    };
    const match = expiry.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!match) return expiry;
    const day = match[1].padStart(2, '0');
    const month = months[match[2]];
    const year = 2000 + parseInt(match[3], 10);
    return `${year}-${month}-${day}`;
  }

  private yearsToExpiry(expiry: string): number {
    const months: Record<string, number> = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    };
    const match = expiry.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!match) return 0;

    const day = parseInt(match[1], 10);
    const month = months[match[2]];
    const year = 2000 + parseInt(match[3], 10);

    const expiryDate = new Date(Date.UTC(year, month, day, 8, 0, 0));
    const diffMs = expiryDate.getTime() - Date.now();
    return diffMs / (365.25 * 24 * 60 * 60 * 1000);
  }
}
