import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { EVENTS, QUEUES } from '@polymarket-ws/shared-types';
import type { TradePayload, EnrichedTrade } from '@polymarket-ws/shared-types';
import { LatestPriceCache } from '../latest-price-cache.service';

@Processor(QUEUES.RAW_TRADES)
export class TradeEnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(TradeEnrichmentProcessor.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: LatestPriceCache,
  ) {
    super();
  }

  async process(job: Job<TradePayload>): Promise<void> {
    const trade = job.data;

    const btcPrice = this.cache.get('BTCUSDT', 'binance')?.price ?? null;
    const deribitData = this.cache.get('BTCUSDT', 'deribit')?.price ?? null;

    const enriched: EnrichedTrade = {
      ...trade,
      btcPriceAtTime: btcPrice,
      deribitIvAtTime: deribitData ? parseFloat(deribitData) : null,
      enrichedAt: Date.now(),
    };

    this.eventEmitter.emit(EVENTS.DERIVED.ENRICHED_TRADE, enriched);
  }
}
