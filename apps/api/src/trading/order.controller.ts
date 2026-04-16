import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  EVENTS,
  QUEUES,
  type OrderIntent,
} from '@polymarket-ws/shared-types';
import { tradingConfig } from '../config/trading.config';
import { EdgeService } from '../edge/edge.service';
import { BankrollCacheService } from './services/bankroll-cache.service';
import { PositionTrackerService } from './services/position-tracker.service';

@Controller()
export class OrderController {
  constructor(
    @Inject(tradingConfig.KEY)
    private readonly cfg: ConfigType<typeof tradingConfig>,
    private readonly positions: PositionTrackerService,
    private readonly bankroll: BankrollCacheService,
    private readonly eventEmitter: EventEmitter2,
    private readonly edgeService: EdgeService,
    @InjectQueue(QUEUES.ORDER_EXECUTION) private readonly queue: Queue,
  ) {}

  @Get('orders')
  async listOrders(@Query('limit') limit?: string) {
    const lim = Math.min(parseInt(limit ?? '100', 10) || 100, 500);
    return this.positions.recentOrders(lim);
  }

  @Get('positions')
  async listPositions() {
    return this.positions.openPositions();
  }

  @Get('trading/status')
  async status() {
    return {
      mode: this.cfg.mode,
      enabled: this.cfg.enabled,
      killswitch: await this.positions.isKillSwitchActive(),
      openPositions: await this.positions.openCount(),
      totalNotional: await this.positions.totalOpenNotional(),
      bankroll: this.bankroll.get(),
    };
  }

  @Get('trading/bankroll')
  bankrollSnapshot() {
    return this.bankroll.get();
  }

  @Post('trading/pause')
  async pause() {
    await this.positions.setKillSwitch(true);
    this.eventEmitter.emit(EVENTS.TRADING.KILLSWITCH_CHANGED, {
      active: true,
    });
    return { killswitch: true };
  }

  @Post('trading/resume')
  async resume() {
    await this.positions.setKillSwitch(false);
    this.eventEmitter.emit(EVENTS.TRADING.KILLSWITCH_CHANGED, {
      active: false,
    });
    return { killswitch: false };
  }

  @Post('trading/bankroll/refresh')
  async refreshBankroll() {
    await this.bankroll.forceRefresh();
    return this.bankroll.get();
  }

  /**
   * Manually close an open position. Enqueues an EXIT intent with reason=manual.
   * Unlike the automatic ExitTriggerService, this bypasses the cooldown bucket
   * and accepts fills at whatever the current mid is.
   */
  @Post('positions/:marketId/close')
  async closePosition(
    @Param('marketId') marketId: string,
    @Body() body: { side?: 'YES' | 'NO' } | undefined,
  ) {
    const open = await this.positions.openPositions();
    const candidates = open.filter((p) => p.marketId === marketId);
    if (candidates.length === 0) {
      throw new NotFoundException(`No open position for market ${marketId}`);
    }
    // If more than one side is open on the same market (possible if ladder
    // entries hit both YES and NO), the caller must disambiguate.
    let position;
    if (candidates.length === 1) {
      position = candidates[0];
    } else {
      if (!body?.side) {
        throw new BadRequestException(
          'Multiple positions open on this market — specify {"side":"YES"|"NO"}',
        );
      }
      position = candidates.find((p) => p.side === body.side);
      if (!position) {
        throw new NotFoundException(
          `No open ${body.side} position on market ${marketId}`,
        );
      }
    }

    const edge = this.edgeService.getMarket(marketId);
    const markPrice =
      edge?.polymarketProbability !== undefined
        ? position.side === 'YES'
          ? edge.polymarketProbability
          : 1 - edge.polymarketProbability
        : position.avgEntryPrice;

    const intent: OrderIntent = {
      marketId: position.marketId,
      tokenId: position.tokenId,
      side: position.side,
      refPrice: markPrice,
      deribitProbability: edge?.deribitProbability ?? 0,
      edge: edge?.edge ?? 0,
      executableEdge: edge?.orderbook?.executableEdge ?? 0,
      fillScore: edge?.orderbook?.fillScore ?? 0,
      fillableAmount: edge?.orderbook?.fillableAmount,
      label: position.label,
      strike: edge?.strike ?? 0,
      expiry: edge?.expiry ?? '',
      slug: edge?.slug,
      createdAt: Date.now(),
      kind: 'EXIT',
      closeReason: 'manual',
      exitSize: position.totalSize,
    };

    this.eventEmitter.emit(EVENTS.TRADING.EXIT_INTENT, intent);

    const job = await this.queue.add('close-position', intent, {
      // No jobId: manual close should never be deduped against the automatic
      // cooldown bucket; operator intent always wins.
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 604_800, count: 500 },
      removeOnFail: { age: 604_800 },
      priority: 1,
    });

    return { enqueued: true, jobId: job.id, intent };
  }
}
