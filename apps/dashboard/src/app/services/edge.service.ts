import { Injectable, NgZone } from '@angular/core';
import { Observable } from 'rxjs';

export interface OrderbookDepth {
  bestAsk?: number;
  bestAskSize?: number;
  bestBid?: number;
  bestBidSize?: number;
  spread?: number;
  fillableAmount?: number;
  effectivePrice?: number;
  executableEdge?: number;
  fillScore?: number;
}

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
  orderbook?: OrderbookDepth;
}

@Injectable({ providedIn: 'root' })
export class EdgeService {
  private readonly baseUrl = '/api';

  constructor(private zone: NgZone) {}

  streamEdge(): Observable<EdgeComparison> {
    return new Observable((subscriber) => {
      const es = new EventSource(`${this.baseUrl}/sse/edge`);
      let lastEvent = Date.now();
      const STALE_MS = 30_000;

      es.addEventListener('edge', (event: MessageEvent) => {
        lastEvent = Date.now();
        this.zone.run(() => {
          subscriber.next(JSON.parse(event.data));
        });
      });

      // Server sends keepalive every 15s — use it to confirm liveness
      es.addEventListener('keepalive', () => {
        lastEvent = Date.now();
      });

      es.onerror = () => {
        this.zone.run(() => {
          subscriber.error(new Error('SSE connection lost'));
        });
      };

      // If no event (edge or keepalive) in STALE_MS, reconnect
      const staleCheck = setInterval(() => {
        if (Date.now() - lastEvent > STALE_MS) {
          this.zone.run(() => {
            subscriber.error(new Error('SSE stream stale'));
          });
        }
      }, 5_000);

      return () => {
        clearInterval(staleCheck);
        es.close();
      };
    });
  }
}