import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { OrderIntent } from '@polymarket-ws/shared-types';
import { tradingConfig } from '../../config/trading.config';
import { BankrollCacheService } from './bankroll-cache.service';
import { PositionTrackerService } from './position-tracker.service';

export interface RiskDecision {
  ok: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

/**
 * Pre-trade validation. Runs in the processor AFTER dequeue, so filters
 * reflect current state (not the state at enqueue time, which could be stale).
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    @Inject(tradingConfig.KEY)
    private readonly cfg: ConfigType<typeof tradingConfig>,
    private readonly positions: PositionTrackerService,
    private readonly bankroll: BankrollCacheService,
  ) {}

  async validate(
    intent: OrderIntent,
    notionalUsd: number,
  ): Promise<RiskDecision> {
    if (!this.cfg.enabled) return { ok: false, reason: 'trading_disabled' };

    if (await this.positions.isKillSwitchActive())
      return { ok: false, reason: 'killswitch' };

    const hoursToExpiry = this.hoursUntilExpiry(intent.expiry);
    if (hoursToExpiry < this.cfg.risk.minHoursToExpiry) {
      return {
        ok: false,
        reason: 'expiry_too_close',
        detail: { hoursToExpiry, min: this.cfg.risk.minHoursToExpiry },
      };
    }

    if (await this.positions.hasOpenPosition(intent.marketId))
      return { ok: false, reason: 'duplicate_market' };

    if (await this.positions.isInCooldown(intent.marketId))
      return { ok: false, reason: 'market_cooldown' };

    const openCount = await this.positions.openCount();
    if (openCount >= this.cfg.risk.maxOpenPositions) {
      return {
        ok: false,
        reason: 'max_open_positions',
        detail: { openCount, max: this.cfg.risk.maxOpenPositions },
      };
    }

    const totalNotional = await this.positions.totalOpenNotional();
    if (totalNotional + notionalUsd > this.cfg.risk.maxTotalNotionalUsd) {
      return {
        ok: false,
        reason: 'max_notional',
        detail: {
          totalNotional,
          adding: notionalUsd,
          cap: this.cfg.risk.maxTotalNotionalUsd,
        },
      };
    }

    const bankroll = this.bankroll.availableForNewOrder(notionalUsd);
    if (!bankroll.ok) {
      return {
        ok: false,
        reason: `bankroll_${bankroll.reason}`,
        detail: {
          equity: bankroll.equity,
          stalenessMs: bankroll.stalenessMs,
        },
      };
    }

    return { ok: true };
  }

  private hoursUntilExpiry(expiry: string): number {
    // expiry format: DDMMMYY e.g. "25APR26" — copied from EdgeService parser.
    const months: Record<string, number> = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    };
    const match = expiry.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!match) return Number.POSITIVE_INFINITY;
    const day = parseInt(match[1], 10);
    const month = months[match[2]];
    const year = 2000 + parseInt(match[3], 10);
    const expiryDate = new Date(Date.UTC(year, month, day, 8, 0, 0));
    return (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60);
  }
}
