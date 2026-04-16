import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ExecutionFill } from '@polymarket-ws/shared-types';
import {
  BuyParams,
  OrderExecutionResult,
  OrderExecutor,
  SellParams,
} from './order-executor.interface';

/**
 * Synthetic executor — always "fills" at refPrice. Used when TRADING_MODE=paper.
 * No network I/O, no state. The BankrollCacheService tracks virtual equity.
 */
@Injectable()
export class PaperExecutor implements OrderExecutor {
  private readonly logger = new Logger(PaperExecutor.name);

  async placeBuy(params: BuyParams): Promise<OrderExecutionResult> {
    const price = Number(params.price);
    this.logger.log(
      `[PAPER] BUY ${params.size} @ $${price.toFixed(4)} (tokenId ${params.tokenId.slice(0, 10)}...)`,
    );
    return this.syntheticFill(params, price);
  }

  async placeSell(params: SellParams): Promise<OrderExecutionResult> {
    const price = Number(params.price);
    this.logger.log(
      `[PAPER] SELL ${params.size} @ $${price.toFixed(4)} (tokenId ${params.tokenId.slice(0, 10)}...)`,
    );
    return this.syntheticFill(params, price);
  }

  private syntheticFill(
    params: BuyParams | SellParams,
    price: number,
  ): OrderExecutionResult {
    const fills: ExecutionFill[] = [
      {
        tradeId: `paper-${randomUUID()}`,
        price,
        size: params.size,
        priceSource: 'paper',
        matchedAt: new Date().toISOString(),
      },
    ];

    return {
      filled: true,
      avgPrice: price,
      filledContracts: params.size,
      fills,
    };
  }
}
