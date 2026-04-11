import { Injectable, NgZone } from '@angular/core';
import { Observable } from 'rxjs';

export interface EdgeComparison {
  marketId: string;
  label: string;
  strike: number;
  expiry: string;
  instrumentName: string;
  deribitProbability: number;
  polymarketProbability: number;
  difference: number;
  underlyingPrice: number;
  impliedVolatility: number;
  advice: 'BUY_YES' | 'BUY_NO' | 'NO_TRADE';
  edge: number;
  error?: string;
  slug?: string;
  volume?: number;
  liquidity?: number;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class EdgeService {
  private readonly baseUrl = '/api';

  constructor(private zone: NgZone) {}

  streamEdge(): Observable<EdgeComparison> {
    return new Observable((subscriber) => {
      const es = new EventSource(`${this.baseUrl}/sse/edge`);

      es.addEventListener('edge', (event: MessageEvent) => {
        this.zone.run(() => {
          subscriber.next(JSON.parse(event.data));
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