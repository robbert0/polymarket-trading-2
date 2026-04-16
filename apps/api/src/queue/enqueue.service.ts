import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EVENTS, QUEUES } from '@polymarket-ws/shared-types';
import type { CryptoPrice, TradePayload } from '@polymarket-ws/shared-types';
import type { DeribitTicker } from '@polymarket-ws/shared-types';

@Injectable()
export class EnqueueService implements OnModuleInit {
  private readonly logger = new Logger(EnqueueService.name);

  constructor(
    @InjectQueue(QUEUES.RAW_PRICES) private readonly rawPricesQueue: Queue,
    @InjectQueue(QUEUES.RAW_TRADES) private readonly rawTradesQueue: Queue,
    @InjectQueue(QUEUES.MARKET_SNAPSHOT) private readonly marketSnapshotQueue: Queue,
    @InjectQueue(QUEUES.EDGE_CALCULATION) private readonly edgeQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.marketSnapshotQueue.upsertJobScheduler(
      'snapshot-scheduler',
      { every: 30_000 },
      { name: 'take-snapshot' },
    );
    this.logger.log('Market snapshot scheduler registered (every 30s)');

    await this.edgeQueue.upsertJobScheduler(
      'edge-scheduler',
      { every: 60_000 },
      { name: 'calculate-edges' },
    );
    this.logger.log('Edge calculation scheduler registered (every 60s)');
  }

  @OnEvent(EVENTS.POLYMARKET.CRYPTO_PRICE)
  async onCryptoPrice(payload: CryptoPrice): Promise<void> {
    await this.rawPricesQueue.add(
      'crypto-price',
      { source: payload.source ?? 'binance', ...payload },
      {
        removeOnComplete: { age: 300, count: 1000 },
        removeOnFail: { age: 3600 },
      },
    );
  }

  @OnEvent(EVENTS.DERIBIT.TICKER)
  async onDeribitTicker(payload: DeribitTicker): Promise<void> {
    await this.rawPricesQueue.add(
      'deribit-ticker',
      { source: 'deribit', ...payload },
      {
        removeOnComplete: { age: 300, count: 1000 },
        removeOnFail: { age: 3600 },
      },
    );
  }

  @OnEvent(EVENTS.POLYMARKET.TRADE)
  async onTrade(payload: TradePayload): Promise<void> {
    await this.rawTradesQueue.add('trade', payload, {
      removeOnComplete: { age: 3600, count: 5000 },
      removeOnFail: { age: 3600 },
    });
  }
}
