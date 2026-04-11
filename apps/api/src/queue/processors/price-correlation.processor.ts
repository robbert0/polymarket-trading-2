import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EVENTS, QUEUES } from '@polymarket-ws/shared-types';
import type { PriceCorrelation } from '@polymarket-ws/shared-types';

const LATEST_PRICES_PREFIX = 'latest-prices';
const STALENESS_THRESHOLD_MS = 10_000;

@Processor(QUEUES.RAW_PRICES)
export class PriceCorrelationProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceCorrelationProcessor.name);
  private redis: Redis;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    @InjectQueue(QUEUES.PRICE_CORRELATION)
    private readonly correlationQueue: Queue,
  ) {
    super();
  }

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

  async process(job: Job): Promise<void> {
    const { source, symbol, price, mark_price, instrument_name, timestamp } =
      job.data;

    const normalizedSymbol = this.normalizeSymbol(
      symbol || instrument_name || '',
    );
    if (!normalizedSymbol) return;

    const priceValue = price ?? mark_price?.toString();
    if (!priceValue) return;

    const key = `${LATEST_PRICES_PREFIX}:${normalizedSymbol}:${source}`;
    await this.redis.hset(key, {
      price: priceValue,
      timestamp: timestamp?.toString() ?? Date.now().toString(),
    });
    await this.redis.expire(key, 60);

    await this.checkAndTriggerCorrelation(normalizedSymbol);
  }

  private async checkAndTriggerCorrelation(symbol: string): Promise<void> {
    const sources = ['binance', 'deribit'];
    const now = Date.now();
    let hasMultipleSources = 0;

    for (const source of sources) {
      const key = `${LATEST_PRICES_PREFIX}:${symbol}:${source}`;
      const data = await this.redis.hgetall(key);
      if (
        data.timestamp &&
        now - parseInt(data.timestamp) < STALENESS_THRESHOLD_MS
      ) {
        hasMultipleSources++;
      }
    }

    if (hasMultipleSources >= 2) {
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
