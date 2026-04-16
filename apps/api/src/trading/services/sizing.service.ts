import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { OrderIntent } from '@polymarket-ws/shared-types';
import { tradingConfig } from '../../config/trading.config';

export interface SizingResult {
  sizeContracts: number;
  notionalUsd: number;
}

/**
 * Phase 1: fixed USD notional per trade, capped by `TRADING_MAX_ORDER_SIZE_USD`.
 * Designed so KellySizingService can later be a drop-in replacement by
 * implementing the same `compute(intent)` shape.
 */
@Injectable()
export class SizingService {
  constructor(
    @Inject(tradingConfig.KEY)
    private readonly cfg: ConfigType<typeof tradingConfig>,
  ) {}

  compute(intent: OrderIntent): SizingResult {
    // EXIT intents carry the position's contract count already; we sell
    // all of it at the current mark. No sizing math needed.
    if (intent.kind === 'EXIT') {
      const sizeContracts = Math.floor(intent.exitSize ?? 0);
      return {
        sizeContracts,
        notionalUsd: sizeContracts * intent.refPrice,
      };
    }

    const notionalTarget = Math.min(
      this.cfg.sizing.fixedOrderSizeUsd,
      this.cfg.sizing.maxOrderSizeUsd,
    );
    if (intent.refPrice <= 0) {
      return { sizeContracts: 0, notionalUsd: 0 };
    }
    const sizeContracts = Math.floor(notionalTarget / intent.refPrice);
    return {
      sizeContracts,
      notionalUsd: sizeContracts * intent.refPrice,
    };
  }
}
