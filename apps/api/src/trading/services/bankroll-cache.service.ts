import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { BankrollSnapshot } from '@polymarket-ws/shared-types';
import { EVENTS } from '@polymarket-ws/shared-types';
import { tradingConfig } from '../../config/trading.config';
import { EdgeService } from '../../edge/edge.service';
import {
  ORDER_EXECUTOR,
  OrderExecutor,
} from '../executors/order-executor.interface';
import { PositionTrackerService } from './position-tracker.service';

/**
 * Wallet-balance cache refreshed in the background every N minutes
 * (`TRADING_BANKROLL_REFRESH_MS`). The hot path — order placement and
 * risk checks — reads from in-memory snapshot, so no order is blocked
 * waiting on an RPC call.
 *
 * Paper mode uses `TRADING_PAPER_BANKROLL_USD` as the synthetic balance
 * and `applyPaperDelta` to subtract spent notional on fills.
 */
@Injectable()
export class BankrollCacheService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(BankrollCacheService.name);
  private snapshot: BankrollSnapshot | null = null;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshInFlight?: Promise<void>;

  constructor(
    @Inject(tradingConfig.KEY)
    private readonly cfg: ConfigType<typeof tradingConfig>,
    @Inject(ORDER_EXECUTOR) private readonly executor: OrderExecutor,
    @Optional() private readonly edgeService: EdgeService,
    private readonly positions: PositionTrackerService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.cfg.mode === 'live') {
      await this.refresh().catch((err) => {
        this.logger.error(
          `Initial bankroll refresh failed: ${(err as Error).message}. Live mode starts with no cache.`,
        );
      });
      this.refreshTimer = setInterval(
        () =>
          this.refresh().catch((err) =>
            this.logger.warn(
              `Bankroll refresh failed: ${(err as Error).message}`,
            ),
          ),
        this.cfg.bankroll.refreshMs,
      );
    } else {
      this.snapshot = {
        usdcBalance: this.cfg.bankroll.paperBankrollUsd,
        tokenBalances: {},
        totalEquityUsd: this.cfg.bankroll.paperBankrollUsd,
        fetchedAt: Date.now(),
        source: 'paper',
      };
      this.eventEmitter.emit(EVENTS.TRADING.BANKROLL_UPDATED, this.snapshot);
    }
  }

  onApplicationShutdown(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /** Zero-latency read for the hot path. */
  get(): BankrollSnapshot | null {
    return this.snapshot;
  }

  /**
   * Hot-path check that an incoming order notional fits within available
   * equity, and that the cache isn't too stale (if stale-block is enabled).
   */
  availableForNewOrder(notionalUsd: number): {
    ok: boolean;
    reason?: string;
    equity: number;
    stalenessMs: number;
  } {
    const snap = this.snapshot;
    if (!snap)
      return {
        ok: false,
        reason: 'no_snapshot',
        equity: 0,
        stalenessMs: Number.POSITIVE_INFINITY,
      };

    const stalenessMs = Date.now() - snap.fetchedAt;
    if (
      stalenessMs > this.cfg.bankroll.maxStaleMs &&
      this.cfg.bankroll.staleBlock &&
      snap.source === 'live'
    ) {
      return {
        ok: false,
        reason: 'stale_cache',
        equity: snap.totalEquityUsd,
        stalenessMs,
      };
    }

    if (notionalUsd > snap.totalEquityUsd) {
      return {
        ok: false,
        reason: 'insufficient_equity',
        equity: snap.totalEquityUsd,
        stalenessMs,
      };
    }

    return { ok: true, equity: snap.totalEquityUsd, stalenessMs };
  }

  /**
   * Paper-mode only: virtually decrement/increment the synthetic bankroll
   * when an order fills. Makes paper look like live for risk limits.
   */
  applyPaperDelta(usdDelta: number): void {
    if (!this.snapshot || this.snapshot.source !== 'paper') return;
    this.snapshot.usdcBalance += usdDelta;
    this.snapshot.totalEquityUsd += usdDelta;
    this.snapshot.fetchedAt = Date.now();
    this.eventEmitter.emit(EVENTS.TRADING.BANKROLL_UPDATED, this.snapshot);
  }

  async forceRefresh(): Promise<void> {
    if (this.cfg.mode !== 'live') return;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const start = Date.now();
      try {
        if (!this.executor.getBalance) {
          this.logger.warn(
            'Executor does not expose getBalance — bankroll cache cannot refresh.',
          );
          return;
        }
        const balance = await this.executor.getBalance();

        const openPositions = await this.positions.openPositions();
        const tokenBalances: Record<string, number> = {};
        for (const pos of openPositions) {
          if (this.executor.getTokenBalance) {
            try {
              tokenBalances[pos.tokenId] =
                await this.executor.getTokenBalance(pos.tokenId);
            } catch (err) {
              this.logger.warn(
                `Failed to fetch token balance for ${pos.tokenId.slice(0, 10)}...: ${(err as Error).message}`,
              );
            }
          }
        }

        let equity = balance.balance;
        for (const [tokenId, contracts] of Object.entries(tokenBalances)) {
          const comparison = this.edgeService?.getMarketByTokenId(tokenId);
          const mid =
            comparison?.orderbook?.bestBid != null &&
            comparison?.orderbook?.bestAsk != null
              ? (comparison.orderbook.bestBid +
                  comparison.orderbook.bestAsk) /
                2
              : (comparison?.polymarketProbability ?? 0);
          equity += contracts * mid;
        }

        this.snapshot = {
          usdcBalance: balance.balance,
          tokenBalances,
          totalEquityUsd: equity,
          fetchedAt: Date.now(),
          source: 'live',
        };

        this.logger.log(
          `Bankroll refreshed: USDC=$${balance.balance.toFixed(2)}, equity=$${equity.toFixed(2)}, ${
            Object.keys(tokenBalances).length
          } tokens, took ${Date.now() - start}ms`,
        );
        this.eventEmitter.emit(EVENTS.TRADING.BANKROLL_UPDATED, this.snapshot);
      } finally {
        this.refreshInFlight = undefined;
      }
    })();

    return this.refreshInFlight;
  }
}
