import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUES } from '@polymarket-ws/shared-types';
import { LatestPriceCache } from '../latest-price-cache.service';

const STALENESS_THRESHOLD_MS = 10_000;

@Processor(QUEUES.RAW_PRICES)
export class PriceCorrelationProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceCorrelationProcessor.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    @InjectQueue(QUEUES.PRICE_CORRELATION)
    private readonly correlationQueue: Queue,
    private readonly cache: LatestPriceCache,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const { source, symbol, price, mark_price, instrument_name, timestamp } =
      job.data;

    const normalizedSymbol = this.normalizeSymbol(
      symbol || instrument_name || '',
    );
    if (!normalizedSymbol) return;

    const priceValue = price ?? mark_price?.toString();
    if (!priceValue) return;

    this.cache.set(
      normalizedSymbol,
      source,
      priceValue,
      timestamp ?? Date.now(),
    );

    await this.checkAndTriggerCorrelation(normalizedSymbol);
  }

  private async checkAndTriggerCorrelation(symbol: string): Promise<void> {
    const sources = ['binance', 'deribit'];
    const now = Date.now();
    let freshSources = 0;

    for (const source of sources) {
      const entry = this.cache.get(symbol, source);
      if (entry && now - entry.timestamp < STALENESS_THRESHOLD_MS) {
        freshSources++;
      }
    }

    if (freshSources >= 2) {
      await this.correlationQueue.add(
        'correlate',
        { symbol },
        {
          removeOnComplete: { age: 3600, count: 2000 },
          removeOnFail: { age: 3600 },
          deduplication: { id: `${symbol}-${Math.floor(Date.now() / 1000)}` },
        },
      );
    }
  }

  private normalizeSymbol(raw: string): string | null {
    const upper = raw.toUpperCase();
    if (upper.includes('BTC')) return 'BTCUSDT';
    if (upper.includes('ETH')) return 'ETHUSDT';
    return null;
  }
}
