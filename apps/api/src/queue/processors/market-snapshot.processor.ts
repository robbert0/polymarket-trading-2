import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { EVENTS, QUEUES } from '@polymarket-ws/shared-types';
import type { MarketSnapshot } from '@polymarket-ws/shared-types';
import { LatestPriceCache } from '../latest-price-cache.service';

@Processor(QUEUES.MARKET_SNAPSHOT)
export class MarketSnapshotProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketSnapshotProcessor.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: LatestPriceCache,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const btcPrice = this.cache.get('BTCUSDT', 'binance')?.price ?? null;
    const ethPrice = this.cache.get('ETHUSDT', 'binance')?.price ?? null;

    const snapshot: MarketSnapshot = {
      markets: [],
      btcPrice,
      ethPrice,
      timestamp: Date.now(),
    };

    this.eventEmitter.emit(EVENTS.DERIVED.MARKET_SNAPSHOT, snapshot);
    this.logger.debug('Market snapshot emitted');
  }
}
