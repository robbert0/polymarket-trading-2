import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import {
  EVENTS,
  QUEUES,
  type OrderIntent,
  type OrderRecord,
} from '@polymarket-ws/shared-types';
import { tradingConfig } from '../../config/trading.config';
import { EdgeService } from '../../edge/edge.service';
import {
  ORDER_EXECUTOR,
  OrderExecutor,
} from '../executors/order-executor.interface';
import { BankrollCacheService } from '../services/bankroll-cache.service';
import { PositionTrackerService } from '../services/position-tracker.service';
import { RiskService } from '../services/risk.service';
import { SizingService } from '../services/sizing.service';

@Processor(QUEUES.ORDER_EXECUTION, {
  concurrency: 1,
  limiter: { max: 10, duration: 60_000 },
})
export class OrderExecutionProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderExecutionProcessor.name);

  constructor(
    @Inject(ORDER_EXECUTOR) private readonly executor: OrderExecutor,
    @Inject(tradingConfig.KEY)
    private readonly cfg: ConfigType<typeof tradingConfig>,
    private readonly risk: RiskService,
    private readonly sizing: SizingService,
    private readonly positions: PositionTrackerService,
    private readonly bankroll: BankrollCacheService,
    private readonly edgeService: EdgeService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<OrderIntent>): Promise<OrderRecord> {
    const intent = job.data;
    const logPrefix = `[job ${job.id}] ${intent.kind} ${intent.side} ${intent.label}`;

    if (intent.kind === 'EXIT') {
      return this.processExit(intent, logPrefix);
    }
    return this.processEntry(intent, logPrefix);
  }

  private async processEntry(
    intent: OrderIntent,
    logPrefix: string,
  ): Promise<OrderRecord> {
    // 1. Re-validate: between enqueue and dequeue (can be seconds under load)
    // any of {advice, executableEdge, fillScore, fillableAmount} may have
    // shifted. Re-check all four against current `EdgeComparison` cache so we
    // never fire on stale signal.
    const fresh = this.edgeService.getMarket(intent.marketId);
    const expectedAdvice = intent.side === 'YES' ? 'BUY_YES' : 'BUY_NO';
    if (!fresh || fresh.advice !== expectedAdvice) {
      return this.recordFailed(intent, 'edge_gone', logPrefix);
    }
    const fob = fresh.orderbook;
    const freshExecEdge = fob?.executableEdge ?? -1;
    if (freshExecEdge < this.cfg.filters.minExecutableEdge) {
      return this.recordFailed(intent, 'edge_dropped', logPrefix);
    }
    const freshFillScore = fob?.fillScore ?? -1;
    if (freshFillScore < this.cfg.filters.minFillScore) {
      return this.recordFailed(intent, 'fill_score_dropped', logPrefix);
    }
    const freshFillable = fob?.fillableAmount ?? -1;
    if (freshFillable < this.cfg.filters.minFillableUsd) {
      return this.recordFailed(intent, 'fillable_dropped', logPrefix);
    }

    // 2. Size first so risk can validate against the actual notional.
    const { sizeContracts, notionalUsd } = this.sizing.compute(intent);
    if (sizeContracts <= 0) {
      return this.recordFailed(intent, 'size_zero', logPrefix);
    }

    // 3. Risk
    const decision = await this.risk.validate(intent, notionalUsd);
    if (!decision.ok) {
      const reason = decision.reason ?? 'risk_rejected';
      this.logger.warn(
        `${logPrefix} rejected by risk: ${reason} ${JSON.stringify(
          decision.detail ?? {},
        )}`,
      );
      await this.positions.setCooldown(
        intent.marketId,
        this.cfg.risk.marketCooldownSec,
      );
      return this.recordFailed(intent, reason, logPrefix);
    }

    // 4. Execute
    let result;
    try {
      result = await this.executor.placeBuy({
        tokenId: intent.tokenId,
        side: intent.side,
        price: intent.refPrice,
        size: sizeContracts,
        maxSlippagePct: this.cfg.maxSlippagePct,
      });
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown';
      this.logger.error(`${logPrefix} executor threw: ${msg}`);
      result = {
        filled: false,
        avgPrice: 0,
        filledContracts: 0,
        fills: [],
        errorMessage: msg,
      };
    }

    // 5. Record + emit
    const record = await this.positions.recordOrder(
      intent,
      result,
      sizeContracts,
      this.cfg.mode,
    );

    if (record.status === 'filled' || record.status === 'partially_filled') {
      // Virtually debit paper bankroll by fill notional (equity is preserved
      // because cost basis sits in tokenBalances in real mode; for paper the
      // position is only synthetic, so we subtract to simulate locked capital).
      if (this.cfg.mode === 'paper') {
        this.bankroll.applyPaperDelta(
          -record.filledSize * record.avgFillPrice,
        );
      }
      this.eventEmitter.emit(EVENTS.TRADING.ORDER_EXECUTED, record);
      this.eventEmitter.emit(EVENTS.TRADING.POSITION_OPENED, record);
    } else {
      await this.positions.setCooldown(
        intent.marketId,
        this.cfg.risk.marketCooldownSec,
      );
      this.eventEmitter.emit(EVENTS.TRADING.ORDER_FAILED, record);
    }

    return record;
  }

  /**
   * EXIT path — no edge re-validation (we want out regardless), no risk check
   * (risk is for opening exposure, not closing it). Sells the entire position
   * at current mark via placeSell.
   */
  private async processExit(
    intent: OrderIntent,
    logPrefix: string,
  ): Promise<OrderRecord> {
    const { sizeContracts } = this.sizing.compute(intent);
    if (sizeContracts <= 0) {
      return this.recordFailed(intent, 'exit_size_zero', logPrefix);
    }

    let result;
    try {
      result = await this.executor.placeSell({
        tokenId: intent.tokenId,
        side: intent.side,
        price: intent.refPrice,
        size: sizeContracts,
        maxSlippagePct: this.cfg.maxSlippagePct,
      });
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown';
      this.logger.error(`${logPrefix} sell executor threw: ${msg}`);
      result = {
        filled: false,
        avgPrice: 0,
        filledContracts: 0,
        fills: [],
        errorMessage: msg,
      };
    }

    const record = await this.positions.recordOrder(
      intent,
      result,
      sizeContracts,
      this.cfg.mode,
    );

    if (record.status === 'filled' || record.status === 'partially_filled') {
      // Paper: credit proceeds back to synthetic bankroll.
      if (this.cfg.mode === 'paper') {
        this.bankroll.applyPaperDelta(
          +record.filledSize * record.avgFillPrice,
        );
      }
      this.eventEmitter.emit(EVENTS.TRADING.ORDER_EXECUTED, record);
      this.eventEmitter.emit(EVENTS.TRADING.POSITION_CLOSED, record);
    } else {
      // Failed sell: short cooldown so ExitTrigger doesn't hammer. The
      // underlying condition (SL/TP/reversal) likely still holds, so we'll
      // try again after the cooldown expires.
      await this.positions.setCooldown(
        intent.marketId,
        this.cfg.exits.exitCooldownSec,
      );
      this.eventEmitter.emit(EVENTS.TRADING.ORDER_FAILED, record);
    }

    return record;
  }

  private async recordFailed(
    intent: OrderIntent,
    reason: string,
    logPrefix: string,
  ): Promise<OrderRecord> {
    this.logger.warn(`${logPrefix} failed: ${reason}`);
    const record = await this.positions.recordOrder(
      intent,
      {
        filled: false,
        avgPrice: 0,
        filledContracts: 0,
        fills: [],
        errorMessage: reason,
      },
      0,
      this.cfg.mode,
    );
    this.eventEmitter.emit(EVENTS.TRADING.ORDER_FAILED, record);
    return record;
  }
}
