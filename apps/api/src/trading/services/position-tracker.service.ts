import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import Redis from 'ioredis';
import type {
  OrderIntent,
  OrderRecord,
  Position,
  ExecutionFill,
} from '@polymarket-ws/shared-types';
import { PG_POOL } from '../../database/database.module';
import { REDIS_CLIENT } from '../redis.provider';
import type { OrderExecutionResult } from '../executors/order-executor.interface';

const REDIS_KEY_POSITIONS_OPEN = 'positions:open';
const REDIS_KEY_COOLDOWN_PREFIX = 'trading:cooldown:';
const REDIS_KEY_KILLSWITCH = 'trading:killswitch';

/**
 * Writes orders + executions to Postgres (append-only, immutable fills).
 * Maintains a hot Redis cache of open-position marketIds so hot-path
 * duplicate-checks in OrderTriggerService don't hit Postgres on every edge event.
 */
@Injectable()
export class PositionTrackerService implements OnModuleInit {
  private readonly logger = new Logger(PositionTrackerService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Rebuild the Redis positions:open set from Postgres position_state at boot.
   * Protects the trigger hot-path from false negatives if Redis was flushed,
   * the key TTL'd, or the deployment swapped instances without a shared cache.
   * Postgres is the source of truth; Redis is a cache.
   */
  async onModuleInit(): Promise<void> {
    const { rows } = await this.pool.query<{ market_id: string }>(
      `SELECT DISTINCT market_id FROM position_state`,
    );

    if (rows.length === 0) {
      this.logger.log('positions:open rehydrate — no open positions found');
      return;
    }

    // Atomic replace: DEL drops any stale entries (e.g. Postgres reset while
    // Redis wasn't), SADD rebuilds. MULTI keeps it atomic so the trigger
    // services never observe a half-rebuilt set.
    const pipeline = this.redis.multi();
    pipeline.del(REDIS_KEY_POSITIONS_OPEN);
    for (const { market_id } of rows) {
      pipeline.sadd(REDIS_KEY_POSITIONS_OPEN, market_id);
    }
    await pipeline.exec();

    this.logger.log(
      `positions:open rehydrated with ${rows.length} market(s) from position_state`,
    );
  }

  /**
   * Persists a new order row + fills (if any) atomically, and updates the
   * Redis positions:open cache iff the order produced fills.
   */
  async recordOrder(
    intent: OrderIntent,
    result: OrderExecutionResult,
    requestedSize: number,
    mode: 'paper' | 'live',
  ): Promise<OrderRecord> {
    const id = randomUUID();
    const filledSize = result.fills.reduce((s, f) => s + Number(f.size), 0);
    const avgFillPrice =
      filledSize > 0
        ? result.fills.reduce((s, f) => s + Number(f.price) * Number(f.size), 0) /
          filledSize
        : 0;

    let status: OrderRecord['status'];
    if (!result.filled && filledSize === 0)
      status = result.errorMessage ? 'failed' : 'rejected';
    else if (filledSize > 0 && filledSize < requestedSize)
      status = 'partially_filled';
    else status = 'filled';

    const record: OrderRecord = {
      id,
      marketId: intent.marketId,
      tokenId: intent.tokenId,
      label: intent.label,
      side: intent.side,
      status,
      refPrice: intent.refPrice,
      limitPrice: intent.refPrice,
      requestedSize,
      filledSize,
      avgFillPrice,
      fills: result.fills,
      externalOrderId: result.externalOrderId,
      errorMessage: result.errorMessage,
      mode,
      edgeAtEntry: intent.edge,
      executableEdgeAtEntry: intent.executableEdge,
      fillScoreAtEntry: intent.fillScore,
      createdAt: intent.createdAt,
      completedAt: Date.now(),
      kind: intent.kind,
      closeReason: intent.closeReason,
    };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO orders (
          id, market_id, token_id, label, side, status,
          ref_price, limit_price, requested_size,
          edge_at_entry, executable_edge_at_entry, fill_score_at_entry,
          mode, external_order_id, error_message, created_at, completed_at,
          kind, close_reason
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,to_timestamp($16/1000.0),to_timestamp($17/1000.0),$18,$19)`,
        [
          record.id,
          record.marketId,
          record.tokenId,
          record.label,
          record.side,
          record.status,
          record.refPrice,
          record.limitPrice,
          record.requestedSize,
          record.edgeAtEntry,
          record.executableEdgeAtEntry,
          record.fillScoreAtEntry,
          record.mode,
          record.externalOrderId ?? null,
          record.errorMessage ?? null,
          record.createdAt,
          record.completedAt,
          record.kind,
          record.closeReason ?? null,
        ],
      );

      for (const fill of record.fills) {
        await client.query(
          `INSERT INTO executions (
            id, order_id, trade_id, price, size, fee_bps, tx_hash, matched_at, price_source
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            record.id,
            fill.tradeId,
            fill.price,
            fill.size,
            fill.feeBps ?? null,
            fill.txHash ?? null,
            fill.matchedAt ? new Date(fill.matchedAt) : null,
            fill.priceSource,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (filledSize > 0) {
      if (record.kind === 'ENTRY') {
        await this.redis.sadd(REDIS_KEY_POSITIONS_OPEN, intent.marketId);
      } else {
        // EXIT: if position_state no longer carries this (market,token,side),
        // the position is fully closed → drop from the hot-path set.
        const stillOpen = await this.pool.query<{ total: string }>(
          `SELECT total_size::text AS total FROM position_state
           WHERE market_id = $1 AND token_id = $2 AND side = $3`,
          [intent.marketId, intent.tokenId, intent.side],
        );
        if (stillOpen.rowCount === 0) {
          await this.redis.srem(REDIS_KEY_POSITIONS_OPEN, intent.marketId);
        }
      }
    }

    this.logger.log(
      `Recorded ${record.kind} ${id.slice(0, 8)} ${record.side} ${record.label} — ${record.status} (${filledSize}/${requestedSize} @ $${avgFillPrice.toFixed(4)})${record.closeReason ? ` reason=${record.closeReason}` : ''}`,
    );

    return record;
  }

  async hasOpenPosition(marketId: string): Promise<boolean> {
    return (
      (await this.redis.sismember(REDIS_KEY_POSITIONS_OPEN, marketId)) === 1
    );
  }

  async openCount(): Promise<number> {
    return this.redis.scard(REDIS_KEY_POSITIONS_OPEN);
  }

  /** Sums cost_basis over open positions from Postgres. */
  async totalOpenNotional(): Promise<number> {
    const { rows } = await this.pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(cost_basis_usd), 0)::text AS total FROM position_state`,
    );
    return parseFloat(rows[0]?.total ?? '0');
  }

  async openPositions(): Promise<Position[]> {
    const { rows } = await this.pool.query<{
      market_id: string;
      token_id: string;
      label: string;
      side: 'YES' | 'NO';
      mode: 'paper' | 'live';
      total_size: string;
      avg_entry_price: string;
      cost_basis_usd: string;
      opened_at: Date;
      last_fill_at: Date;
      order_ids: string[];
    }>(
      `SELECT market_id, token_id, label, side, mode, total_size, avg_entry_price,
              cost_basis_usd, opened_at, last_fill_at, order_ids
       FROM position_state`,
    );
    return rows.map((r) => ({
      marketId: r.market_id,
      tokenId: r.token_id,
      label: r.label,
      side: r.side,
      totalSize: parseFloat(r.total_size),
      avgEntryPrice: parseFloat(r.avg_entry_price),
      costBasisUsd: parseFloat(r.cost_basis_usd),
      orderIds: r.order_ids,
      status: 'open',
      openedAt: r.opened_at.getTime(),
      lastOrderAt: r.last_fill_at.getTime(),
      mode: r.mode,
    }));
  }

  async recentOrders(limit = 100): Promise<OrderRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT o.*,
              COALESCE(
                json_agg(
                  json_build_object(
                    'tradeId', e.trade_id,
                    'price', e.price,
                    'size', e.size,
                    'feeBps', e.fee_bps,
                    'txHash', e.tx_hash,
                    'matchedAt', e.matched_at,
                    'priceSource', e.price_source
                  ) ORDER BY e.created_at
                ) FILTER (WHERE e.id IS NOT NULL),
                '[]'::json
              ) AS fills
       FROM orders o
       LEFT JOIN executions e ON e.order_id = o.id
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $1`,
      [limit],
    );

    return rows.map((r) => this.rowToRecord(r));
  }

  async setCooldown(marketId: string, seconds: number): Promise<void> {
    await this.redis.set(
      `${REDIS_KEY_COOLDOWN_PREFIX}${marketId}`,
      '1',
      'EX',
      seconds,
    );
  }

  async isInCooldown(marketId: string): Promise<boolean> {
    return (
      (await this.redis.exists(`${REDIS_KEY_COOLDOWN_PREFIX}${marketId}`)) === 1
    );
  }

  async setKillSwitch(active: boolean): Promise<void> {
    if (active) {
      await this.redis.set(REDIS_KEY_KILLSWITCH, '1');
    } else {
      await this.redis.del(REDIS_KEY_KILLSWITCH);
    }
  }

  async isKillSwitchActive(): Promise<boolean> {
    return (await this.redis.exists(REDIS_KEY_KILLSWITCH)) === 1;
  }

  private rowToRecord(r: Record<string, unknown>): OrderRecord {
    const fills = r.fills as ExecutionFill[];
    const filledSize = fills.reduce((s, f) => s + Number(f.size ?? 0), 0);
    const avgFillPrice =
      filledSize > 0
        ? fills.reduce((s, f) => s + Number(f.price) * Number(f.size), 0) /
          filledSize
        : 0;

    const createdAt = r.created_at as Date;
    const completedAt = r.completed_at as Date | null;

    return {
      id: r.id as string,
      marketId: r.market_id as string,
      tokenId: r.token_id as string,
      label: r.label as string,
      side: r.side as 'YES' | 'NO',
      status: r.status as OrderRecord['status'],
      refPrice: Number(r.ref_price ?? 0),
      limitPrice: Number(r.limit_price ?? 0),
      requestedSize: Number(r.requested_size ?? 0),
      filledSize,
      avgFillPrice,
      fills,
      externalOrderId: (r.external_order_id as string | null) ?? undefined,
      errorMessage: (r.error_message as string | null) ?? undefined,
      mode: r.mode as 'paper' | 'live',
      edgeAtEntry: Number(r.edge_at_entry ?? 0),
      executableEdgeAtEntry: Number(r.executable_edge_at_entry ?? 0),
      fillScoreAtEntry: Number(r.fill_score_at_entry ?? 0),
      createdAt: createdAt.getTime(),
      completedAt: completedAt ? completedAt.getTime() : undefined,
      kind: ((r.kind as string) ?? 'ENTRY') as OrderRecord['kind'],
      closeReason:
        (r.close_reason as OrderRecord['closeReason']) ?? undefined,
    };
  }
}
