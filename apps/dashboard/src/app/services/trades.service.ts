import { Injectable, NgZone } from '@angular/core';
import { Observable } from 'rxjs';

export interface Trade {
  asset: string;
  slug: string;
  eventSlug: string;
  title: string;
  outcome: string;
  outcomeIndex: number;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  name: string;
  pseudonym: string;
  icon: string;
  transactionHash: string;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class TradesService {
  private readonly baseUrl = '/api';

  constructor(private zone: NgZone) {}

  streamTrades(market?: string): Observable<Trade> {
    return new Observable((subscriber) => {
      const params = market ? `?market=${encodeURIComponent(market)}` : '';
      const es = new EventSource(`${this.baseUrl}/sse/trades${params}`);

      es.onmessage = (event) => {
        this.zone.run(() => {
          subscriber.next(JSON.parse(event.data));
        });
      };

      es.onerror = () => {
        this.zone.run(() => {
          subscriber.error(new Error('SSE connection lost'));
        });
      };

      return () => es.close();
    });
  }
}
