import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '@polymarket-ws/shared-types';
import { HealthController, RedisHealthIndicator } from './health.controller';

@Module({
  imports: [
    TerminusModule,
    BullModule.registerQueue({ name: QUEUES.RAW_PRICES }),
  ],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
