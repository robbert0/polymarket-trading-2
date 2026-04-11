import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUES } from '@polymarket-ws/shared-types';
import { EdgeModule } from '../edge/edge.module';
import { EnqueueService } from './enqueue.service';
import { PriceCorrelationProcessor } from './processors/price-correlation.processor';
import { TradeEnrichmentProcessor } from './processors/trade-enrichment.processor';
import { MarketSnapshotProcessor } from './processors/market-snapshot.processor';
import { CorrelationCombinerProcessor } from './processors/correlation-combiner.processor';
import { EdgeCalculationProcessor } from './processors/edge-calculation.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get('redis.host', 'localhost'),
          port: configService.get('redis.port', 6379),
          password: configService.get('redis.password', undefined),
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: QUEUES.RAW_PRICES },
      { name: QUEUES.RAW_TRADES },
      { name: QUEUES.RAW_ORDERBOOK },
      { name: QUEUES.PRICE_CORRELATION },
      { name: QUEUES.MARKET_SNAPSHOT },
      { name: QUEUES.EDGE_CALCULATION },
    ),
    EdgeModule,
  ],
  providers: [
    EnqueueService,
    PriceCorrelationProcessor,
    TradeEnrichmentProcessor,
    MarketSnapshotProcessor,
    CorrelationCombinerProcessor,
    EdgeCalculationProcessor,
  ],
  exports: [BullModule],
})
export class QueueModule {}
