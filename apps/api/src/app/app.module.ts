import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HttpModule } from '@nestjs/axios';
import { appConfig } from '../config/app.config';
import { polymarketConfig } from '../config/polymarket.config';
import { redisConfig } from '../config/redis.config';
import { deribitConfig } from '../config/deribit.config';
import { edgeConfig } from '../config/edge.config';
import { tradingConfig } from '../config/trading.config';
import { postgresConfig } from '../config/postgres.config';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { DeribitModule } from '../deribit/deribit.module';
import { QueueModule } from '../queue/queue.module';
import { HealthModule } from '../health/health.module';
import { DatabaseModule } from '../database/database.module';
import { TradingModule } from '../trading/trading.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        polymarketConfig,
        redisConfig,
        deribitConfig,
        edgeConfig,
        tradingConfig,
        postgresConfig,
      ],
    }),
    EventEmitterModule.forRoot(),
    HttpModule,
    DatabaseModule,
    PolymarketModule,
    DeribitModule,
    QueueModule,
    HealthModule,
    TradingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
