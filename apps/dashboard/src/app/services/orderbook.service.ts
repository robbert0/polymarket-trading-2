import { Injectable, NgZone } from '@angular/core';
import { Observable } from 'rxjs';

export interface BookUpdate {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  tick_size: string;
  event_type: string;
  last_trade_price?: string;
}

export interface PriceChange {
  asset_id: string;
  price: string;
  size: string;
  side: string;
  best_bid: string;
  best_ask: string;
}

export type MarketEvent =
  | { type: 'book'; data: BookUpdate }
  | { type: 'price_change'; data: PriceChange };

@Injectable({ providedIn: 'root' })
export class OrderbookService {
  private readonly baseUrl = '/api';

  constructor(private zone: NgZone) {}

  streamMarket(assetId: string): Observable<MarketEvent> {
    return new Observable((subscriber) => {
      const es = new EventSource(`${this.baseUrl}/sse/market/${assetId}`);

      es.addEventListener('book', (event: MessageEvent) => {
        this.zone.run(() => {
          subscriber.next({ type: 'book', data: JSON.parse(event.data) });
        });
      });

      es.addEventListener('price_change', (event: MessageEvent) => {
        this.zone.run(() => {
          subscriber.next({ type: 'price_change', data: JSON.parse(event.data) });
        });
      });

      es.onmessage = (event) => {
        this.zone.run(() => {
          const data = JSON.parse(event.data);
          if (data.bids || data.asks) {
            subscriber.next({ type: 'book', data });
          } else if (data.asset_id && data.price) {
            subscriber.next({ type: 'price_change', data });
          }
        });
      };

      es.onerror = () => {
        // EventSource auto-reconnects on transient errors.
        // Only signal error if permanently closed.
        if (es.readyState === EventSource.CLOSED) {
          this.zone.run(() => {
            subscriber.error(new Error('SSE connection lost'));
          });
        }
      };

      return () => es.close();
    });
  }
}
