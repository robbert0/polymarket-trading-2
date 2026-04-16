import { Injectable, NgZone, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type OrderSide = 'YES' | 'NO';
export type OrderStatus =
  | 'pending'
  | 'filled'
  | 'partially_filled'
  | 'rejected'
  | 'failed';
export type TradingMode = 'paper' | 'live';
export type OrderKind = 'ENTRY' | 'EXIT';
export type CloseReason =
  | 'stop_loss'
  | 'take_profit'
  | 'edge_reversal'
  | 'expiry_flat'
  | 'manual';

export interface ExecutionFill {
  tradeId: string;
  price: number;
  size: number;
  feeBps?: number;
  txHash?: string;
  matchedAt?: string;
  priceSource: 'trade' | 'fallback' | 'paper';
}

export interface OrderRecord {
  id: string;
  marketId: string;
  tokenId: string;
  label: string;
  side: OrderSide;
  status: OrderStatus;
  refPrice: number;
  limitPrice: number;
  requestedSize: number;
  filledSize: number;
  avgFillPrice: number;
  fills: ExecutionFill[];
  externalOrderId?: string;
  errorMessage?: string;
  mode: TradingMode;
  edgeAtEntry: number;
  executableEdgeAtEntry: number;
  fillScoreAtEntry: number;
  createdAt: number;
  completedAt?: number;
  kind: OrderKind;
  closeReason?: CloseReason;
}

export interface BankrollSnapshot {
  usdcBalance: number;
  tokenBalances: Record<string, number>;
  totalEquityUsd: number;
  fetchedAt: number;
  source: TradingMode;
}

export interface TradingStatus {
  mode: TradingMode;
  enabled: boolean;
  killswitch: boolean;
  openPositions: number;
  totalNotional: number;
  bankroll: BankrollSnapshot | null;
}

export interface Position {
  marketId: string;
  tokenId: string;
  label: string;
  side: OrderSide;
  totalSize: number;
  avgEntryPrice: number;
  costBasisUsd: number;
  orderIds: string[];
  status: 'open' | 'closed';
  openedAt: number;
  lastOrderAt: number;
  mode: TradingMode;
}

export type OrdersStreamEvent =
  | { type: 'order_executed'; data: OrderRecord }
  | { type: 'order_failed'; data: OrderRecord }
  | { type: 'bankroll'; data: BankrollSnapshot }
  | { type: 'killswitch'; data: { active: boolean } }
  | { type: 'keepalive' };

@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly baseUrl = '/api';
  private readonly zone = inject(NgZone);
  private readonly http = inject(HttpClient);

  listRecent(limit = 100): Observable<OrderRecord[]> {
    return this.http.get<OrderRecord[]>(
      `${this.baseUrl}/orders?limit=${limit}`,
    );
  }

  listPositions(): Observable<Position[]> {
    return this.http.get<Position[]>(`${this.baseUrl}/positions`);
  }

  getStatus(): Observable<TradingStatus> {
    return this.http.get<TradingStatus>(`${this.baseUrl}/trading/status`);
  }

  pause(): Observable<{ killswitch: boolean }> {
    return this.http.post<{ killswitch: boolean }>(
      `${this.baseUrl}/trading/pause`,
      {},
    );
  }

  resume(): Observable<{ killswitch: boolean }> {
    return this.http.post<{ killswitch: boolean }>(
      `${this.baseUrl}/trading/resume`,
      {},
    );
  }

  closePosition(
    marketId: string,
    side?: OrderSide,
  ): Observable<{ enqueued: boolean; jobId: string }> {
    return this.http.post<{ enqueued: boolean; jobId: string }>(
      `${this.baseUrl}/positions/${marketId}/close`,
      side ? { side } : {},
    );
  }

  streamOrders(): Observable<OrdersStreamEvent> {
    return new Observable((subscriber) => {
      const es = new EventSource(`${this.baseUrl}/sse/orders`);
      let lastEvent = Date.now();
      const STALE_MS = 30_000;

      const bump = () => (lastEvent = Date.now());

      es.addEventListener('order_executed', (ev: MessageEvent) => {
        bump();
        this.zone.run(() =>
          subscriber.next({
            type: 'order_executed',
            data: JSON.parse(ev.data) as OrderRecord,
          }),
        );
      });
      es.addEventListener('order_failed', (ev: MessageEvent) => {
        bump();
        this.zone.run(() =>
          subscriber.next({
            type: 'order_failed',
            data: JSON.parse(ev.data) as OrderRecord,
          }),
        );
      });
      es.addEventListener('bankroll', (ev: MessageEvent) => {
        bump();
        this.zone.run(() =>
          subscriber.next({
            type: 'bankroll',
            data: JSON.parse(ev.data) as BankrollSnapshot,
          }),
        );
      });
      es.addEventListener('killswitch', (ev: MessageEvent) => {
        bump();
        this.zone.run(() =>
          subscriber.next({
            type: 'killswitch',
            data: JSON.parse(ev.data) as { active: boolean },
          }),
        );
      });
      es.addEventListener('keepalive', () => {
        bump();
        this.zone.run(() => subscriber.next({ type: 'keepalive' }));
      });

      es.onopen = () => {
        bump();
        this.zone.run(() => subscriber.next({ type: 'keepalive' }));
      };

      es.onerror = () => {
        this.zone.run(() =>
          subscriber.error(new Error('SSE orders connection lost')),
        );
      };

      const staleCheck = setInterval(() => {
        if (Date.now() - lastEvent > STALE_MS) {
          this.zone.run(() =>
            subscriber.error(new Error('SSE orders stream stale')),
          );
        }
      }, 5_000);

      return () => {
        clearInterval(staleCheck);
        es.close();
      };
    });
  }
}
