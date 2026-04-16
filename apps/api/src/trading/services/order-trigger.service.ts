import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  EVENTS,
  QUEUES,
  type EdgeComparison,
  type OrderIntent,
} from '@polymarket-ws/shared-types';
import { tradingConfig } from '../../config/trading.config';
import { EdgeService } from '../../edge/edge.service';
import { PositionTrackerService } from './position-tracker.service';

/**
 * Listens to EdgeService's edge emissions, filters on executableEdge /
 * fillScore / fillable / dedup / duplicate-position / cooldown, and
 * enqueues a sized-independent OrderIntent. All heavy I/O stays downstream
 * in the processor — this stays fast and memory-bound.
 */
@Injectable()
export class OrderTriggerService {
  private readonly logger = new Logger(OrderTriggerService.name);
  /** minute-bucketed in-memory dedup: marketId:bucket → timestamp */
  private readonly recentAttempts = new Map<string, number>();
  private lastPrune = Date.now();

  constructor(
    @InjectQueue(QUEUES.ORDER_EXECUTION) private readonly queue: Queue,
    @Inject(tradingConfig.KEY)
    private readonly cfg: ConfigType<typeof tradingConfig>,
    private readonly positions: PositionTrackerService,
    private readonly edgeService: EdgeService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent(EVENTS.DERIVED.EDGE)
  async onEdge(edge: EdgeComparison): Promise<void> {
    if (!this.cfg.enabled) return;
    if (edge.advice === 'NO_TRADE') return;
    if (!edge.orderbook) return;

    const { executableEdge, fillScore, fillableAmount } = edge.orderbook;
    if (
      executableEdge == null ||
      executableEdge < this.cfg.filters.minExecutableEdge
    )
      return;
    if (fillScore == null || fillScore < this.cfg.filters.minFillScore) return;
    if (
      fillableAmount == null ||
      fillableAmount < this.cfg.filters.minFillableUsd
    )
      return;

    const bucket = Math.floor(Date.now() / 60_000);
    const attemptKey = `${edge.marketId}:${bucket}`;
    if (this.recentAttempts.has(attemptKey)) return;
    this.recentAttempts.set(attemptKey, Date.now());
    this.maybePrune();

    if (await this.positions.hasOpenPosition(edge.marketId)) return;
    if (await this.positions.isInCooldown(edge.marketId)) return;
    if (await this.positions.isKillSwitchActive()) return;

    const tokens = this.edgeService.getTokens(edge.marketId);
    if (!tokens) {
      this.logger.warn(
        `No cached tokens for market ${edge.marketId} — skipping.`,
      );
      return;
    }

    const side: 'YES' | 'NO' = edge.advice === 'BUY_YES' ? 'YES' : 'NO';
    const tokenId = side === 'YES' ? tokens.yesTokenId : tokens.noTokenId;
    // For BUY_NO, refPrice is the NO-token probability = 1 - polymarket YES prob
    const refPrice =
      side === 'YES'
        ? edge.polymarketProbability
        : 1 - edge.polymarketProbability;

    const intent: OrderIntent = {
      marketId: edge.marketId,
      tokenId,
      side,
      refPrice,
      deribitProbability: edge.deribitProbability,
      edge: edge.edge,
      executableEdge,
      fillScore,
      fillableAmount,
      label: edge.label,
      strike: edge.strike,
      expiry: edge.expiry,
      slug: edge.slug,
      createdAt: Date.now(),
      kind: 'ENTRY',
    };

    this.eventEmitter.emit(EVENTS.TRADING.ORDER_INTENT, intent);

    await this.queue.add('place-order', intent, {
      jobId: `order:${edge.marketId}:${bucket}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 604_800, count: 500 },
      removeOnFail: { age: 604_800 },
    });

    this.logger.log(
      `Enqueued ${side} intent for ${edge.label} ` +
        `(execEdge ${(executableEdge * 100).toFixed(2)}%, fillScore ${fillScore}, ` +
        `fillable $${fillableAmount.toFixed(0)})`,
    );
  }

  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    const cutoff = now - 120_000;
    for (const [k, v] of this.recentAttempts) {
      if (v < cutoff) this.recentAttempts.delete(k);
    }
  }
}
