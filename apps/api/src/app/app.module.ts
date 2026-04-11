import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HttpModule } from '@nestjs/axios';
import { appConfig } from '../config/app.config';
import { polymarketConfig } from '../config/polymarket.config';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { HealthModule } from '../health/health.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, polymarketConfig],
    }),
    EventEmitterModule.forRoot(),
    HttpModule,
    PolymarketModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
