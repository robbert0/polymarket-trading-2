import { Injectable, NgZone } from '@angular/core';
import { Observable } from 'rxjs';

export interface DeribitTicker {
  instrument_name: string;
  mark_price: number;
  index_price: number;
  last_price: number;
  best_bid_price: number;
  best_ask_price: number;
  best_bid_amount: number;
  best_ask_amount: number;
  open_interest: number;
  current_funding: number;
  funding_8h: number;
  volume_24h: number;
  price_change_24h: number;
  timestamp: number;
}

export interface DeribitOption {
  instrument_name: string;
  underlying_price: number;
  mark_price: number;
  mark_iv: number;
  bid_iv: number;
  ask_iv: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  open_interest: number;
  volume_24h: number;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class DeribitService {
  private readonly baseUrl = '/api';

  constructor(private zone: NgZone) {}

  streamDeribit(): Observable<{ type: string; data: DeribitTicker | DeribitOption }> {
    return new Observable((subscriber) => {
      const es = new EventSource(`${this.baseUrl}/sse/deribit`);

      es.addEventListener('deribit_ticker', (event: MessageEvent) => {
        this.zone.run(() => {
          subscriber.next({ type: 'ticker', data: JSON.parse(event.data) });
        });
      });

      es.addEventListener('deribit_options', (event: MessageEvent) => {
        this.zone.run(() => {
          subscriber.next({ type: 'options', data: JSON.parse(event.data) });
        });
      });

      es.onerror = () => {
        this.zone.run(() => {
          subscriber.error(new Error('SSE connection lost'));
        });
      };

      return () => es.close();
    });
  }
}
