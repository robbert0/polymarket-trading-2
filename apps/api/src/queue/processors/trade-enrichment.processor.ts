import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { EVENTS, QUEUES } from '@polymarket-ws/shared-types';
import type { TradePayload, EnrichedTrade } from '@polymarket-ws/shared-types';

const LATEST_PRICES_PREFIX = 'latest-prices';

@Processor(QUEUES.RAW_TRADES)
export class TradeEnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(TradeEnrichmentProcessor.name);
  private redis: Redis;

  async onModuleInit(): Promise<void> {
    const opts = this.worker.opts.connection as { host: string; port: number; password?: string };
    this.redis = new Redis({
      host: opts.host ?? 'localhost',
      port: opts.port ?? 6379,
      password: opts.password,
      lazyConnect: true,
    });
    await this.redis.connect();
  }

  async process(job: Job<TradePayload>): Promise<void> {
    const trade = job.data;

    const btcPrice = await this.getLatestPrice('BTCUSDT', 'binance');
    const deribitData = await this.getLatestPrice('BTCUSDT', 'deribit');

    const enriched: EnrichedTrade = {
      ...trade,
      btcPriceAtTime: btcPrice,
      deribitIvAtTime: deribitData ? parseFloat(deribitData) : null,
      enrichedAt: Date.now(),
    };

    this.eventEmitter.emit(EVENTS.DERIVED.ENRICHED_TRADE, enriched);
  }

  private async getLatestPrice(
    symbol: string,
    source: string,
  ): Promise<string | null> {
    const key = `${LATEST_PRICES_PREFIX}:${symbol}:${source}`;
    const data = await this.redis.hgetall(key);
    return data.price ?? null;
  }

  constructor(private readonly eventEmitter: EventEmitter2) {
    super();
  }
}
