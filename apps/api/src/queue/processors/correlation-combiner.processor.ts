import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { EVENTS, QUEUES } from '@polymarket-ws/shared-types';
import type { PriceCorrelation } from '@polymarket-ws/shared-types';
import { LatestPriceCache } from '../latest-price-cache.service';

@Processor(QUEUES.PRICE_CORRELATION)
export class CorrelationCombinerProcessor extends WorkerHost {
  private readonly logger = new Logger(CorrelationCombinerProcessor.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: LatestPriceCache,
  ) {
    super();
  }

  async process(job: Job<{ symbol: string }>): Promise<void> {
    const { symbol } = job.data;

    const binanceData = this.cache.get(symbol, 'binance');
    const deribitData = this.cache.get(symbol, 'deribit');

    const binancePrice = binanceData?.price ?? null;
    const deribitPrice = deribitData?.price
      ? parseFloat(deribitData.price)
      : null;

    let basisSpread: number | null = null;
    let maxDivergence: number | null = null;

    if (binancePrice && deribitPrice) {
      const spot = parseFloat(binancePrice);
      basisSpread = ((deribitPrice - spot) / spot) * 100;

      const prices = [spot, deribitPrice].filter(Boolean);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      maxDivergence = min > 0 ? ((max - min) / min) * 100 : null;
    }

    const correlation: PriceCorrelation = {
      symbol,
      binancePrice,
      polymarketPrice: null,
      deribitPrice,
      deribitFunding: null,
      basisSpread,
      maxDivergencePercent: maxDivergence,
      timestamp: Date.now(),
    };

    this.eventEmitter.emit(EVENTS.DERIVED.PRICE_CORRELATION, correlation);
    this.logger.debug(
      `Correlation for ${symbol}: basis=${basisSpread?.toFixed(4)}%`,
    );
  }
}
