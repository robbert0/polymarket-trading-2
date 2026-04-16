import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  EVENTS,
  QUEUES,
  type CloseReason,
  type EdgeComparison,
  type OrderIntent,
  type Position,
} from '@polymarket-ws/shared-types';
import { tradingConfig } from '../../config/trading.config';
import { PositionTrackerService } from './position-tracker.service';

/**
 * Phase 4 — close open positions on any of:
 *  - stop-loss: mark price dropped below avgEntry * (1 - stopLossPct)
 *  - take-profit: mark price above avgEntry * (1 + takeProfitPct)
 *  - edge-reversal: executableEdge flipped against the position
 *  - expiry-flat: market expires within flattenHoursBeforeExpiry
 *
 * Re-uses the same `order-execution` queue as entries. JobId dedup keyed on
 * `exit:{marketId}:{bucket}` keeps a thrashy market from firing N EXIT jobs.
 * The processor routes on `intent.kind` — ENTRY → placeBuy, EXIT → placeSell.
 */
@Injectable()
export class ExitTriggerService {
  private readonly logger = new Logger(ExitTriggerService.name);
  /** marketId → bucket-keyed attempt timestamp (second-granularity dedup) */
  private readonly recentAttempts = new Map<string, number>();
  private lastPrune = Date.now();

  constructor(
    @InjectQueue(QUEUES.ORDER_EXECUTION) private readonly queue: Queue,
    @Inject(tradingConfig.KEY)
    private readonly cfg: ConfigType<typeof tradingConfig>,
    private readonly positions: PositionTrackerService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent(EVENTS.DERIVED.EDGE)
  async onEdge(edge: EdgeComparison): Promise<void> {
    if (!this.cfg.enabled) return;
    // Fast short-circuit: if we have no open position on this market,
    // there's nothing to exit. `hasOpenPosition` is a Redis SISMEMBER — ns-fast.
    if (!(await this.positions.hasOpenPosition(edge.marketId))) return;
    if (await this.positions.isKillSwitchActive()) {
      // Killswitch blocks entries AND exits — operator is asserting manual control.
      return;
    }

    // Load open positions filtered to this market. Usually 1, rarely 2.
    const openPositions = await this.positions.openPositions();
    const here = openPositions.filter((p) => p.marketId === edge.marketId);
    if (here.length === 0) return;

    for (const position of here) {
      const reason = this.evaluateExit(position, edge);
      if (!reason) continue;
      await this.enqueueExit(position, edge, reason);
    }
  }

  /**
   * Decide whether `position` should be closed given the current market state.
   * Priority order: expiry-flat > stop-loss > take-profit > edge-reversal.
   * Expiry wins because liquidity dies near settlement — holding for another
   * trigger can mean no bid exists.
   */
  private evaluateExit(
    position: Position,
    edge: EdgeComparison,
  ): CloseReason | null {
    const markPrice = this.markPriceForSide(position.side, edge);
    if (markPrice === undefined) return null;

    // Expiry-flat — highest priority, based on market's endDate
    // EdgeComparison carries `expiry` like "29MAR25"; parse via yearsToExpiry
    // equivalent. We reuse the hours-to-expiry calc inline.
    const hoursToExpiry = this.hoursToExpiry(edge.expiry);
    if (
      hoursToExpiry !== null &&
      hoursToExpiry <= this.cfg.exits.flattenHoursBeforeExpiry
    ) {
      return 'expiry_flat';
    }

    // Stop-loss: unrealised loss greater than stopLossPct of cost basis.
    const lossPct = (position.avgEntryPrice - markPrice) / position.avgEntryPrice;
    if (lossPct >= this.cfg.exits.stopLossPct) {
      return 'stop_loss';
    }

    // Take-profit: unrealised gain above takeProfitPct of cost basis.
    const gainPct = (markPrice - position.avgEntryPrice) / position.avgEntryPrice;
    if (gainPct >= this.cfg.exits.takeProfitPct) {
      return 'take_profit';
    }

    // Edge reversal — the executable edge has flipped against this side
    // beyond `reversalEdgeThreshold`. This means: Deribit now says our side
    // is the wrong side of the trade.
    const reversed = this.isEdgeReversed(position.side, edge);
    if (reversed) return 'edge_reversal';

    return null;
  }

  private markPriceForSide(
    side: 'YES' | 'NO',
    edge: EdgeComparison,
  ): number | undefined {
    const yesP = edge.polymarketProbability;
    if (yesP === undefined || yesP === null) return undefined;
    return side === 'YES' ? yesP : 1 - yesP;
  }

  /**
   * Returns true if the current edge advises buying the *opposite* side of the
   * position, AND the executableEdge magnitude exceeds the reversal threshold.
   * This is the "the trade we took is no longer justified" signal.
   */
  private isEdgeReversed(side: 'YES' | 'NO', edge: EdgeComparison): boolean {
    const opposite = side === 'YES' ? 'BUY_NO' : 'BUY_YES';
    if (edge.advice !== opposite) return false;
    const execEdge = edge.orderbook?.executableEdge;
    if (execEdge === undefined || execEdge === null) return false;
    return execEdge >= this.cfg.exits.reversalEdgeThreshold;
  }

  /** "29MAR25" → hours until that expiry (8:00 UTC). Null on parse failure. */
  private hoursToExpiry(expiry: string): number | null {
    const months: Record<string, number> = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    };
    const match = expiry.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!match) return null;
    const day = parseInt(match[1], 10);
    const month = months[match[2]];
    const year = 2000 + parseInt(match[3], 10);
    const expiryMs = Date.UTC(year, month, day, 8, 0, 0);
    return (expiryMs - Date.now()) / 3_600_000;
  }

  private async enqueueExit(
    position: Position,
    edge: EdgeComparison,
    reason: CloseReason,
  ): Promise<void> {
    // Bucketed dedup — at most one EXIT enqueue per position per
    // exitCooldownSec. Prevents thrashing a tight-spread market.
    const bucket = Math.floor(
      Date.now() / (this.cfg.exits.exitCooldownSec * 1000),
    );
    const key = `${position.marketId}:${position.side}:${bucket}`;
    if (this.recentAttempts.has(key)) return;
    this.recentAttempts.set(key, Date.now());
    this.maybePrune();

    const markPrice =
      this.markPriceForSide(position.side, edge) ?? position.avgEntryPrice;

    const intent: OrderIntent = {
      marketId: position.marketId,
      tokenId: position.tokenId,
      side: position.side,
      refPrice: markPrice,
      // Exit orders don't need Deribit context, but we carry it for telemetry.
      deribitProbability: edge.deribitProbability,
      edge: edge.edge,
      executableEdge: edge.orderbook?.executableEdge ?? 0,
      fillScore: edge.orderbook?.fillScore ?? 0,
      fillableAmount: edge.orderbook?.fillableAmount,
      label: position.label,
      strike: edge.strike,
      expiry: edge.expiry,
      slug: edge.slug,
      createdAt: Date.now(),
      kind: 'EXIT',
      closeReason: reason,
      exitSize: position.totalSize,
    };

    this.eventEmitter.emit(EVENTS.TRADING.EXIT_INTENT, intent);

    await this.queue.add('close-position', intent, {
      jobId: `exit:${position.marketId}:${position.side}:${bucket}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 604_800, count: 500 },
      removeOnFail: { age: 604_800 },
      // Small priority so exits preempt entries on queue contention; BullMQ
      // priorities are ascending (lower number = higher priority).
      priority: 1,
    });

    this.logger.warn(
      `Enqueued EXIT ${position.side} ${position.label} (reason=${reason}, ` +
        `mark=${markPrice.toFixed(4)}, entry=${position.avgEntryPrice.toFixed(4)}, ` +
        `size=${position.totalSize.toFixed(2)})`,
    );
  }

  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    const cutoff = now - this.cfg.exits.exitCooldownSec * 2000;
    for (const [k, v] of this.recentAttempts) {
      if (v < cutoff) this.recentAttempts.delete(k);
    }
  }
}
