import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { EVENTS, QUEUES } from '@polymarket-ws/shared-types';
import type { MarketSnapshot } from '@polymarket-ws/shared-types';

const LATEST_PRICES_PREFIX = 'latest-prices';

@Processor(QUEUES.MARKET_SNAPSHOT)
export class MarketSnapshotProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketSnapshotProcessor.name);
  private redis: Redis;

  constructor(private readonly eventEmitter: EventEmitter2) {
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

  async process(_job: Job): Promise<void> {
    const btcPrice = await this.getLatestPrice('BTCUSDT', 'binance');
    const ethPrice = await this.getLatestPrice('ETHUSDT', 'binance');

    const snapshot: MarketSnapshot = {
      markets: [],
      btcPrice,
      ethPrice,
      timestamp: Date.now(),
    };

    this.eventEmitter.emit(EVENTS.DERIVED.MARKET_SNAPSHOT, snapshot);
    this.logger.debug('Market snapshot emitted');
  }

  private async getLatestPrice(
    symbol: string,
    source: string,
  ): Promise<string | null> {
    const key = `${LATEST_PRICES_PREFIX}:${symbol}:${source}`;
    const data = await this.redis.hgetall(key);
    return data.price ?? null;
  }
}
