import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { EVENTS, QUEUES } from '@polymarket-ws/shared-types';
import type { PriceCorrelation } from '@polymarket-ws/shared-types';

const LATEST_PRICES_PREFIX = 'latest-prices';

@Processor(QUEUES.PRICE_CORRELATION)
export class CorrelationCombinerProcessor extends WorkerHost {
  private readonly logger = new Logger(CorrelationCombinerProcessor.name);
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

  async process(job: Job<{ symbol: string }>): Promise<void> {
    const { symbol } = job.data;

    const binanceData = await this.getPriceData(symbol, 'binance');
    const deribitData = await this.getPriceData(symbol, 'deribit');

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

  private async getPriceData(
    symbol: string,
    source: string,
  ): Promise<{ price: string; timestamp: string } | null> {
    const key = `${LATEST_PRICES_PREFIX}:${symbol}:${source}`;
    const data = await this.redis.hgetall(key);
    return data.price ? (data as { price: string; timestamp: string }) : null;
  }
}
