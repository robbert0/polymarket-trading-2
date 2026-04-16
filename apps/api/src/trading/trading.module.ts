import { Logger, Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '@polymarket-ws/shared-types';
import { tradingConfig } from '../config/trading.config';
import { EdgeModule } from '../edge/edge.module';
import { DatabaseModule } from '../database/database.module';
import { redisClientProvider } from './redis.provider';
import {
  ORDER_EXECUTOR,
  OrderExecutor,
} from './executors/order-executor.interface';
import { PaperExecutor } from './executors/paper.executor';
import { PolymarketExecutor } from './executors/polymarket.executor';
import { OrderTriggerService } from './services/order-trigger.service';
import { ExitTriggerService } from './services/exit-trigger.service';
import { RiskService } from './services/risk.service';
import { SizingService } from './services/sizing.service';
import { BankrollCacheService } from './services/bankroll-cache.service';
import { PositionTrackerService } from './services/position-tracker.service';
import { OrderExecutionProcessor } from './processors/order-execution.processor';
import { OrderController } from './order.controller';

/**
 * Wires the trading pipeline. The ORDER_EXECUTOR factory chooses paper vs
 * live based on `TRADING_MODE`. Live mode is not yet implemented (Phase 3);
 * requesting it throws early.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.ORDER_EXECUTION }),
    DatabaseModule,
    EdgeModule,
  ],
  providers: [
    redisClientProvider,
    PaperExecutor,
    {
      provide: ORDER_EXECUTOR,
      useFactory: (
        cfg: ConfigType<typeof tradingConfig>,
        paper: PaperExecutor,
      ): OrderExecutor => {
        if (cfg.mode === 'live') {
          if (!cfg.polymarket.privateKey) {
            throw new Error(
              'TRADING_MODE=live requires POLYMARKET_PRIVATE_KEY. Run ' +
                '`ts-node apps/api/src/trading/scripts/derive-api-key.ts` ' +
                'to derive L2 credentials.',
            );
          }
          if (
            !cfg.polymarket.apiKey ||
            !cfg.polymarket.secret ||
            !cfg.polymarket.passphrase
          ) {
            throw new Error(
              'TRADING_MODE=live requires POLYMARKET_API_KEY, ' +
                'POLYMARKET_SECRET, POLYMARKET_PASSPHRASE. Derive via ' +
                'scripts/derive-api-key.ts.',
            );
          }
          Logger.warn(
            '🔴 LIVE TRADING MODE — real orders will be placed on Polymarket',
            'TradingModule',
          );
          return new PolymarketExecutor({
            privateKey: cfg.polymarket.privateKey,
            apiKey: cfg.polymarket.apiKey,
            secret: cfg.polymarket.secret,
            passphrase: cfg.polymarket.passphrase,
            maxOrderSizeUsd: cfg.sizing.maxOrderSizeUsd,
            maxSlippagePct: cfg.maxSlippagePct,
            signatureType: cfg.polymarket.signatureType,
            negRisk: cfg.polymarket.negRisk,
          });
        }
        Logger.log('📄 Paper trading mode', 'TradingModule');
        return paper;
      },
      inject: [tradingConfig.KEY, PaperExecutor],
    },
    PositionTrackerService,
    SizingService,
    BankrollCacheService,
    RiskService,
    OrderTriggerService,
    ExitTriggerService,
    OrderExecutionProcessor,
  ],
  controllers: [OrderController],
  exports: [PositionTrackerService, BankrollCacheService],
})
export class TradingModule {}
