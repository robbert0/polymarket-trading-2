import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
  DeribitTicker,
  DeribitOption,
  PriceChangeMessage,
} from '@polymarket-ws/shared-types';
import { DeribitWsService } from '../deribit/deribit-ws.service';
import { ClobWsService } from '../polymarket/clob-ws/clob-ws.service';
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
export class EdgeService implements OnModuleInit {
  private readonly logger = new Logger(EdgeService.name);
  private readonly GAMMA_API = 'https://gamma-api.polymarket.com';

  /** marketId → cached market data */
  private marketCache = new Map<string, CachedMarket>();
  /** Deribit instrument name → marketId (for fast lookup on option ticker) */
  private instrumentToMarket = new Map<string, string>();
  /** Polymarket YES token ID → marketId (for fast lookup on price_change) */
  private tokenToMarket = new Map<string, string>();

  constructor(
    private readonly httpService: HttpService,
    private readonly eventEmitter: EventEmitter2,
    private readonly deribitWsService: DeribitWsService,
    private readonly clobWsService: ClobWsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshMarkets();
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
   * Polymarket CLOB price change — update YES price for the matching market.
   */
  @OnEvent(EVENTS.POLYMARKET.PRICE_CHANGE)
  onPolymarketPriceChange(payload: PriceChangeMessage): void {
    const marketId = this.tokenToMarket.get(payload.asset_id);
    if (!marketId) return;

    const market = this.marketCache.get(marketId);
    if (!market) return;

    const newPrice = parseFloat(payload.price);
    if (isNaN(newPrice) || newPrice <= 0 || newPrice >= 1) return;

    market.yesPrice = newPrice;
    this.recalculateAndEmit(market);
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
    let advice: 'BUY_YES' | 'BUY_NO' | 'NO_TRADE' = 'NO_TRADE';
    let edge = 0;

    if (diff > ARBITRAGE_EDGE_THRESHOLD) {
      advice = 'BUY_YES';
      edge = diff;
    } else if (diff < -ARBITRAGE_EDGE_THRESHOLD) {
      advice = 'BUY_NO';
      edge = Math.abs(diff);
    }

    if (edge > 0.5) {
      this.logger.warn(
        `Suspicious edge ${(edge * 100).toFixed(1)}% on ${market.label}: ` +
          `deribit=${(deribitProbability * 100).toFixed(1)}% poly=${(market.yesPrice * 100).toFixed(1)}% ` +
          `spot=${market.spotPrice} strike=${market.strike} iv=${(market.iv * 100).toFixed(1)}% T=${T.toFixed(4)}`,
      );
    }

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
    };

    this.eventEmitter.emit(EVENTS.DERIVED.EDGE, comparison);
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
